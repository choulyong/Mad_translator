// Generate PWA icons as simple SVG-based PNGs
// Uses sharp if available, otherwise creates SVG placeholders
import fs from "fs";
import path from "path";

const ICONS_DIR = path.join(process.cwd(), "public", "icons");
fs.mkdirSync(ICONS_DIR, { recursive: true });

function createSVG(size, maskable = false) {
  const padding = maskable ? size * 0.1 : 0;
  const innerSize = size - padding * 2;
  const cx = size / 2;
  const cy = size / 2;
  const filmSize = innerSize * 0.45;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#09090b" rx="${maskable ? 0 : size * 0.15}"/>
  <g transform="translate(${cx - filmSize / 2}, ${cy - filmSize / 2})">
    <rect x="0" y="0" width="${filmSize}" height="${filmSize}" rx="${filmSize * 0.08}" fill="none" stroke="#17cf5a" stroke-width="${filmSize * 0.06}"/>
    <!-- film perforations left -->
    <rect x="${filmSize * 0.08}" y="${filmSize * 0.15}" width="${filmSize * 0.1}" height="${filmSize * 0.08}" rx="${filmSize * 0.02}" fill="#17cf5a"/>
    <rect x="${filmSize * 0.08}" y="${filmSize * 0.3}" width="${filmSize * 0.1}" height="${filmSize * 0.08}" rx="${filmSize * 0.02}" fill="#17cf5a"/>
    <rect x="${filmSize * 0.08}" y="${filmSize * 0.45}" width="${filmSize * 0.1}" height="${filmSize * 0.08}" rx="${filmSize * 0.02}" fill="#17cf5a"/>
    <rect x="${filmSize * 0.08}" y="${filmSize * 0.6}" width="${filmSize * 0.1}" height="${filmSize * 0.08}" rx="${filmSize * 0.02}" fill="#17cf5a"/>
    <rect x="${filmSize * 0.08}" y="${filmSize * 0.75}" width="${filmSize * 0.1}" height="${filmSize * 0.08}" rx="${filmSize * 0.02}" fill="#17cf5a"/>
    <!-- film perforations right -->
    <rect x="${filmSize * 0.82}" y="${filmSize * 0.15}" width="${filmSize * 0.1}" height="${filmSize * 0.08}" rx="${filmSize * 0.02}" fill="#17cf5a"/>
    <rect x="${filmSize * 0.82}" y="${filmSize * 0.3}" width="${filmSize * 0.1}" height="${filmSize * 0.08}" rx="${filmSize * 0.02}" fill="#17cf5a"/>
    <rect x="${filmSize * 0.82}" y="${filmSize * 0.45}" width="${filmSize * 0.1}" height="${filmSize * 0.08}" rx="${filmSize * 0.02}" fill="#17cf5a"/>
    <rect x="${filmSize * 0.82}" y="${filmSize * 0.6}" width="${filmSize * 0.1}" height="${filmSize * 0.08}" rx="${filmSize * 0.02}" fill="#17cf5a"/>
    <rect x="${filmSize * 0.82}" y="${filmSize * 0.75}" width="${filmSize * 0.1}" height="${filmSize * 0.08}" rx="${filmSize * 0.02}" fill="#17cf5a"/>
    <!-- center frame -->
    <rect x="${filmSize * 0.25}" y="${filmSize * 0.15}" width="${filmSize * 0.5}" height="${filmSize * 0.7}" rx="${filmSize * 0.04}" fill="#17cf5a" opacity="0.15"/>
    <!-- play triangle -->
    <polygon points="${filmSize * 0.4},${filmSize * 0.35} ${filmSize * 0.4},${filmSize * 0.65} ${filmSize * 0.65},${filmSize * 0.5}" fill="#17cf5a"/>
  </g>
</svg>`;
}

// Generate SVG files, then convert to PNG via sharp or keep as SVG
const sizes = [
  { size: 192, name: "icon-192.png", maskable: false },
  { size: 512, name: "icon-512.png", maskable: false },
  { size: 192, name: "icon-maskable-192.png", maskable: true },
  { size: 512, name: "icon-maskable-512.png", maskable: true },
  { size: 180, name: "../apple-touch-icon.png", maskable: false },
];

let sharp;
try {
  sharp = (await import("sharp")).default;
} catch {
  console.log("sharp not found, trying to install...");
  const { execSync } = await import("child_process");
  try {
    execSync("npm install sharp --no-save", { stdio: "inherit", cwd: process.cwd() });
    sharp = (await import("sharp")).default;
  } catch {
    console.log("Could not install sharp. Saving as SVG instead.");
  }
}

for (const { size, name, maskable } of sizes) {
  const svg = createSVG(size, maskable);
  const outPath = path.join(ICONS_DIR, name);

  if (sharp) {
    await sharp(Buffer.from(svg)).png().toFile(outPath);
    console.log(`Created ${name} (${size}x${size} PNG)`);
  } else {
    // Save SVG with .png extension as fallback (browsers handle it)
    const svgPath = outPath.replace(".png", ".svg");
    fs.writeFileSync(svgPath, svg);
    console.log(`Created ${name.replace(".png", ".svg")} (SVG fallback)`);
  }
}

console.log("Done!");
