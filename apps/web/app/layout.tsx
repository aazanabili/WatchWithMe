import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: 'Watch With Me', template: '%s — Watch With Me' },
  description: 'غرفة مشاهدة متزامنة لمشاركة اللحظات معاً.',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'Watch With Me',
    locale: 'ar',
    title: 'Watch With Me',
    description: 'غرفة مشاهدة متزامنة لمشاركة اللحظات معاً.',
  },
  twitter: {
    card: 'summary',
    title: 'Watch With Me',
    description: 'غرفة مشاهدة متزامنة لمشاركة اللحظات معاً.',
  },
  robots: { index: true, follow: true },
};
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
