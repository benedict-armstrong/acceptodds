export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-8 font-sans">
      <h1 className="text-2xl font-semibold">papermarket</h1>
      <p className="mt-4 text-sm opacity-80">
        A prediction market venue. Trading runs on an LMSR cost function and a
        non-convertible play currency called reputation.
      </p>
      <p className="mt-4 text-sm opacity-60">
        The UI is not built yet. The venue is the engine and the public API.
      </p>
    </main>
  );
}
