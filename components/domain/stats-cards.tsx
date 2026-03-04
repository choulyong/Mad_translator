"use client";

import { History, TrendingUp, Clock } from "lucide-react";
import { useScanStore } from "@/lib/store/scan-store";

export function StatsCards() {
  const { files } = useScanStore();

  const total = files.length;
  const doneCount = files.filter((f) => f.status === "done" || f.status === "moved").length;
  const successRate = total > 0 ? Math.round((doneCount / total) * 100) : 0;
  const pendingCount = files.filter(
    (f) => f.status === "idle" || f.status === "ready"
  ).length;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4">
      <StatCard
        label="총 스캔 완료"
        value={total}
        icon={History}
        iconBg="bg-primary/10"
        iconColor="text-primary"
      />
      <StatCard
        label="성공률"
        value={`${successRate}%`}
        icon={TrendingUp}
        iconBg="bg-blue-500/10"
        iconColor="text-blue-400"
      />
      <StatCard
        label="대기 중인 작업"
        value={pendingCount}
        icon={Clock}
        iconBg="bg-amber-500/10"
        iconColor="text-amber-400"
      />
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: number | string;
  icon: React.ComponentType<{ className?: string }>;
  iconBg: string;
  iconColor: string;
}

function StatCard({ label, value, icon: Icon, iconBg, iconColor }: StatCardProps) {
  return (
    <div className="bg-surface-dark border border-border-dark rounded-xl p-4 flex items-center justify-between">
      <div>
        <p className="text-xs text-zinc-500 mb-1">{label}</p>
        <p className="text-2xl font-bold text-zinc-100">{value}</p>
      </div>
      <div className={`w-10 h-10 rounded-lg ${iconBg} flex items-center justify-center`}>
        <Icon className={`w-5 h-5 ${iconColor}`} />
      </div>
    </div>
  );
}
