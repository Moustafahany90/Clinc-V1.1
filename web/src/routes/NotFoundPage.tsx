import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { Button, Card } from '../components/ui';

export function NotFoundPage() {
  return (
    <Card className="mx-auto mt-10 max-w-md p-8 text-center">
      <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
        <Compass className="h-5 w-5" aria-hidden />
      </span>
      <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-600">
        404
      </p>
      <h1 className="mt-1 text-lg font-semibold text-ink-950">Page not found</h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
        The page you are looking for may have moved, or you may not have a link to it yet.
      </p>
      <Button asChild className="mt-5" variant="secondary">
        <Link to="/">Back to dashboard</Link>
      </Button>
    </Card>
  );
}
