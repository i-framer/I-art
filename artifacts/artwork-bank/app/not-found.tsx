import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-stone-50 text-stone-900">
      <h1 className="text-6xl font-bold text-stone-300 mb-4">404</h1>
      <p className="text-xl text-stone-600 mb-8">Page not found</p>
      <Link
        href="/"
        className="px-4 py-2 bg-stone-800 text-white rounded hover:bg-stone-700 transition-colors"
      >
        Go home
      </Link>
    </div>
  );
}
