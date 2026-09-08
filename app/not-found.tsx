import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        That route does not exist.{" "}
        <Link href="/" className="text-primary underline underline-offset-2">
          Back to the dashboard
        </Link>
        .
      </p>
    </div>
  );
}
