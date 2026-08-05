import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { VITE_DEFAULT_PORT } from '@/constants/dev';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function normalizedBasePath(path: string): string {
  const value = path.trim();
  if (!value || value === '/') return '/';
  return `/${value.replace(/^\/+|\/+$/g, '')}/`;
}

export function getBaseUrl(
  pathname: string = window.location.pathname,
  configuredBasePath: string | undefined = window.ENV?.BASE_PATH
) {
  if (configuredBasePath) return normalizedBasePath(configuredBasePath);

  const marker = `/${VITE_DEFAULT_PORT}/`;
  const markerIndex = pathname.indexOf(marker);
  if (pathname.includes('notebook-sessions') && markerIndex >= 0) {
    return normalizedBasePath(pathname.slice(0, markerIndex + marker.length));
  }
  return '/';
}

export function getAppUrl(path: string) {
  const relativePath = path.replace(/^\/+/, '');
  return new URL(`${getBaseUrl()}${relativePath}`, `${window.location.origin}/`).toString();
}

export function getApiUrl() {
  return getAppUrl('api');
}
