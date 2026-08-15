import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Elessar — Global Situational Awareness',
  description:
    'Open-source situational awareness platform: live global event dashboard, OSINT ingestion from free sources, and machine-learning correlation across data streams.',
  applicationName: 'Elessar',
};

export const viewport: Viewport = {
  themeColor: '#080b10',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `data-theme="dark"` is set server-side so the first paint is already dark.
    // Without it a dark-default console flashes white on every navigation.
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
