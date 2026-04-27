export function nextLockNo(last?: string | null) {
  const n = Number(last ?? "0");
  const next = n + 1;
  return String(next).padStart(3, "0"); // 001,002,...
}