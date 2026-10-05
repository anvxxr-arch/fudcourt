import { PagePanel, PagePanelLink } from '@/ui/page-chrome';

export default function FrontendNotFound() {
  return (
    <PagePanel title="NOT FOUND" action={<PagePanelLink href="/">Back to the landing page</PagePanelLink>}>
      This route does not exist — try the navigation bar, or head back to the landing page.
    </PagePanel>
  );
}
