import { PagePanel, PagePanelLink } from '@/ui/page-chrome';

export default function NotFound() {
  return (
    <PagePanel title="404 — page not found" action={<PagePanelLink href="/">Back to the landing page</PagePanelLink>}>
      This page does not exist — try the navigation bar, or head back to the landing page.
    </PagePanel>
  );
}
