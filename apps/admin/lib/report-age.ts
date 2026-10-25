export function reportAge(createdAt: Date | string, now = Date.now()) {
  const hours = Math.max(0, (now - new Date(createdAt).getTime()) / 3_600_000);
  return { label: hours < 1 ? "менее часа" : `${Math.floor(hours)} ч`, overdue: hours > 24 };
}
