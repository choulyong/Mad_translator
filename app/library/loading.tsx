export default function Loading() {
  return (
    <>
      <header className="h-16 flex items-center px-8 border-b border-border-dark">
        <div className="h-6 w-32 bg-zinc-800 rounded animate-pulse" />
      </header>
      <div className="p-8">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-3">
              <div className="aspect-[2/3] rounded-xl bg-zinc-800 animate-pulse" />
              <div className="space-y-2 px-1">
                <div className="h-4 bg-zinc-800 rounded w-3/4 animate-pulse" />
                <div className="h-3 bg-zinc-800 rounded w-1/2 animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
