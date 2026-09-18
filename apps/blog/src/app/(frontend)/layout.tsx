import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'FudCourt Blog',
  description: 'Insights, research, and playbooks from FudCourt.',
};

export default function FrontendLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}