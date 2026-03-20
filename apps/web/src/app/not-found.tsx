import Link from "next/link";
import { Home } from "lucide-react";

export default function NotFound() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center space-y-4">
        <div className="text-6xl font-bold text-text-muted/20">404</div>
        <h2 className="text-lg font-bold">Page not found</h2>
        <p className="text-sm text-text-muted">
          The page you&apos;re looking for doesn&apos;t exist.
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-white text-sm hover:bg-primary-hover"
        >
          <Home className="w-4 h-4" />
          Back to Overview
        </Link>
      </div>
    </div>
  );
}
