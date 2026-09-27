export function deliverySocketUrl(token: string): string {
  const configured = import.meta.env.VITE_WS_URL;
  if (configured) {
    const url = new URL(configured);
    url.searchParams.set('token', token);
    return url.toString();
  }

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/ws?token=${encodeURIComponent(token)}`;
}
