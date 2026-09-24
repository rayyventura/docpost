export function formatDate(iso: string, withTime = false): string {
  const date = new Date(iso);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = String(date.getFullYear());
  const formatted = `${day}/${month}/${year}`;
  if (!withTime) return formatted;

  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${formatted}, ${hours}:${minutes}`;
}
