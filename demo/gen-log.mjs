// Generate a deterministic, SYNTHETIC Unreal-style editor log (no real project data) for the demo.
// Usage: node demo/gen-log.mjs [lines] [shift] > out.log
// `shift` perturbs the content slightly so two logs can be diffed.
const n = parseInt(process.argv[2] || "6000", 10);
const shift = parseInt(process.argv[3] || "0", 10);
const ms = (i) => String(i % 1000).padStart(3, "0");
const fr = (i) => String(i % 600).padStart(4, " ");
const out = [];
for (let i = 0; i < n; i++) {
  const actor = `Actor_${(i + shift) % 12}`;
  const t = (i + shift) % 10;
  if (t < 6) {
    out.push(
      `[2024.01.01-00.00.00:${ms(i)}][${fr(i)}]LogMove: Display: Mover.cpp(566) Tick Pawn=${actor} ts=${(1000 + i * 0.016).toFixed(3)} Alpha=${(i % 100) / 100}`,
    );
  } else if (t < 9) {
    out.push(`[2024.01.01-00.00.00:${ms(i)}][${fr(i)}]LogSync: Warning: Sync.cpp(120) Drift Pawn=${actor} Gap=${i % 50}`);
  } else if (i % 50 === 0) {
    out.push(`Src/Build.cpp(${100 + (i % 30)}): error C2065: undeclared identifier`);
  } else {
    out.push(`[2024.01.01-00.00.00:${ms(i)}][${fr(i)}]LogNull: Error: Null.cpp(45) null pointer id ${i}`);
  }
}
// One injected NEW error every ~800 lines when shifted, so `diff` has something to surface.
if (shift) {
  for (let i = 0; i < out.length; i += 800) {
    out[i] = `[2024.01.01-00.00.00:000][   0]LogGpu: Error: Gpu.cpp(9) device removed during present`;
  }
}
process.stdout.write(out.join("\n") + "\n");
