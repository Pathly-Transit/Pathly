import { useAuth } from '../auth/AuthContext';

const DEFAULT_ADMIN_EMAILS = 'admin@gmail.com';

/**
 * The admin emails: the backend's ADMIN_EMAILS, passed in as EXPO_PUBLIC_ADMIN_EMAILS by
 * app.config.js (default admin@gmail.com). This only decides which screens to show: the backend
 * checks the caller's verified email itself.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const configured = process.env.EXPO_PUBLIC_ADMIN_EMAILS || DEFAULT_ADMIN_EMAILS;
  return configured.split(',').some((admin) => admin.trim().toLowerCase() === email.toLowerCase());
}

export function useIsAdmin(): boolean {
  return isAdminUser(useAuth().user);
}

/** A client hint only; backend callables separately verify the token's email ownership. */
export function isAdminUser(user: { email?: string | null; emailVerified?: boolean } | null | undefined): boolean {
  return user?.emailVerified === true && isAdminEmail(user.email);
}
