"""Database configuration and utilities for job persistence"""
import os
from sqlalchemy import create_engine, Column, String, Integer, Float, Boolean, DateTime, Text, JSON
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from datetime import datetime
import json

# Database connection parameters (from .env or defaults)
DB_USER = os.getenv("DB_USER", "postgres")
# Password is URL-encoded in .env: %5E%5E = ^^
DB_PASSWORD_ENCODED = os.getenv("DB_PASSWORD", "gksrnr82%5E%5E")
# Decode URL encoding
from urllib.parse import unquote
DB_PASSWORD = unquote(DB_PASSWORD_ENCODED)
DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = os.getenv("DB_PORT", "5433")
DB_NAME = os.getenv("DB_NAME", "subtitle")

print(f"[DB] Initialized with config: {DB_HOST}:{DB_PORT}/{DB_NAME} (user={DB_USER})")

# Lazy initialization - engine and session created on first use
_engine = None
_SessionLocal = None

Base = declarative_base()

def get_engine():
    """Get or create database engine (lazy initialization)"""
    global _engine
    if _engine is None:
        try:
            def get_db_connection():
                """Create database connection with proper parameter handling"""
                import psycopg2
                return psycopg2.connect(
                    dbname=DB_NAME,
                    user=DB_USER,
                    password=DB_PASSWORD,
                    host=DB_HOST,
                    port=int(DB_PORT),
                    client_encoding='UTF8'
                )

            from sqlalchemy.pool import NullPool
            _engine = create_engine(
                "postgresql://",
                creator=get_db_connection,
                echo=False,
                pool_pre_ping=True,
                pool_recycle=3600,
                poolclass=NullPool
            )
            print(f"[DB] Engine created successfully")
        except Exception as e:
            print(f"[DB_ERROR] Failed to create engine: {e}")
            return None
    return _engine

def get_sessionmaker():
    """Get or create session factory (lazy initialization)"""
    global _SessionLocal
    if _SessionLocal is None:
        engine = get_engine()
        if engine:
            _SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    return _SessionLocal


class TranslationJob(Base):
    """Translation job persistence model"""
    __tablename__ = "translation_jobs"

    job_id = Column(String(12), primary_key=True, index=True)
    status = Column(String(20), default="running")  # running, complete, failed, cancelled
    progress = Column(Integer, default=0)  # 0-100
    current_pass = Column(String(100), default="초기화")
    logs = Column(JSON, default=list)  # List of log strings
    result = Column(JSON, nullable=True)  # Final result dict
    cancelled = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    error = Column(Text, nullable=True)  # Error message if failed

    def to_dict(self):
        """Convert to dictionary for API response"""
        return {
            "job_id": self.job_id,
            "status": self.status,
            "progress": self.progress,
            "current_pass": self.current_pass,
            "logs": self.logs or [],
            "result": self.result,
            "cancelled": self.cancelled,
            "created_at": self.created_at.timestamp() if self.created_at else None,
            "error": self.error,
        }


def init_db():
    """Initialize database tables"""
    try:
        engine = get_engine()
        if engine is None:
            print("[DB_WARN] Database disabled - running in memory-only mode")
            return False
        Base.metadata.create_all(bind=engine)
        print("[DB] Database initialized successfully")
        return True
    except Exception as e:
        print(f"[DB_WARN] Database connection failed: {str(e)[:100]}")
        print("[DB_WARN] Continuing without database persistence (memory-only mode)")
        return False


def get_session():
    """Get database session"""
    SessionLocal = get_sessionmaker()
    if SessionLocal is None:
        print("[DB_ERROR] SessionLocal is None")
        return None
    return SessionLocal()


def save_job_to_db(job_id: str, job_data: dict):
    """Save job to database"""
    session = get_session()
    try:
        # Convert numeric timestamps to datetime objects if needed
        for time_field in ["created_at", "updated_at"]:
            if time_field in job_data and isinstance(job_data[time_field], (int, float)):
                job_data[time_field] = datetime.fromtimestamp(job_data[time_field])

        # Check if job exists
        existing = session.query(TranslationJob).filter(TranslationJob.job_id == job_id).first()

        if existing:
            # Update existing job
            for key, value in job_data.items():
                if hasattr(existing, key):
                    setattr(existing, key, value)
            existing.updated_at = datetime.utcnow()
        else:
            # Create new job
            job_data['job_id'] = job_id
            job = TranslationJob(**job_data)
            session.add(job)

        session.commit()
        return True
    except Exception as e:
        session.rollback()
        print(f"[DB_ERROR] Failed to save job {job_id}: {e}")
        return False
    finally:
        session.close()


def load_job_from_db(job_id: str) -> dict:
    """Load job from database"""
    session = get_session()
    try:
        job = session.query(TranslationJob).filter(TranslationJob.job_id == job_id).first()
        if job:
            return job.to_dict()
        return None
    except Exception as e:
        print(f"[DB_ERROR] Failed to load job {job_id}: {e}")
        return None
    finally:
        session.close()


def load_all_running_jobs() -> dict[str, dict]:
    """Load all running jobs for recovery on startup"""
    session = get_session()
    try:
        jobs = session.query(TranslationJob).filter(
            TranslationJob.status == "running"
        ).all()
        result = {}
        for job in jobs:
            result[job.job_id] = job.to_dict()
        print(f"[DB] Loaded {len(result)} running jobs from database")
        return result
    except Exception as e:
        print(f"[DB_ERROR] Failed to load running jobs: {e}")
        return {}
    finally:
        session.close()


def delete_job_from_db(job_id: str):
    """Delete job from database"""
    session = get_session()
    try:
        session.query(TranslationJob).filter(TranslationJob.job_id == job_id).delete()
        session.commit()
        return True
    except Exception as e:
        session.rollback()
        print(f"[DB_ERROR] Failed to delete job {job_id}: {e}")
        return False
    finally:
        session.close()


def _save_jobs_to_file():
    """Backup jobs to JSON file (for redundancy - primary is DB)"""
    try:
        from app.api.subtitles import _jobs
        from pathlib import Path

        backup_path = Path(__file__).parent.parent / "jobs_backup.json"
        with open(backup_path, 'w', encoding='utf-8') as f:
            json.dump(_jobs, f, indent=2, ensure_ascii=False)
        print(f"[DB] Backed up {len(_jobs)} jobs to {backup_path}")
        return True
    except Exception as e:
        print(f"[DB_ERROR] Failed to backup jobs: {e}")
        return False
