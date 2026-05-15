const BASE_URL = import.meta.env.BASE_URL || '/';

export function appUrl(path: string): string {
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  return `${BASE_URL}${cleanPath}`;
}

export function appWsUrl(path: string): string {
  const url = new URL(appUrl(path), window.location.href);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
