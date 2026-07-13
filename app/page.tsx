import Link from 'next/link'

export default function Home() {
  return (
    <div className="brand-shell min-h-screen text-white flex flex-col items-center justify-center px-6">
      <p className="text-emerald-300 text-xs tracking-[3px] uppercase font-semibold">
        Jukebox colaborativo
      </p>
      <h1 className="text-4xl md:text-5xl font-bold mt-3 text-center bg-gradient-to-r from-emerald-200 via-emerald-400 to-teal-300 bg-clip-text text-transparent">
        NATMusicQR
      </h1>
      <p className="text-emerald-100/60 mt-3 text-center max-w-md">
        Escanea el QR de tu mesa, elige una canción y suena en la TV del local.
      </p>

      <div className="mt-10 flex flex-col sm:flex-row gap-3 w-full max-w-sm">
        <Link
          href="/join/natmusicqr"
          className="flex-1 text-center rounded-full bg-emerald-500 hover:bg-emerald-400 font-semibold py-3.5 text-zinc-950 shadow-lg shadow-emerald-900/50"
        >
          Entrar como mesa
        </Link>
        <Link
          href="/player/natmusicqr"
          className="flex-1 text-center rounded-full border border-emerald-700/70 bg-emerald-950/40 hover:border-emerald-500 hover:bg-emerald-950/70 py-3.5 text-emerald-100"
        >
          Pantalla TV
        </Link>
      </div>

      <div className="mt-12 text-xs text-zinc-600 space-y-1 text-center">
        <p>QR mesa 4 → /join/natmusicqr?mesa=4</p>
        <p>QR mesa 7 → /join/natmusicqr?mesa=7</p>
        <p className="text-zinc-700">
          Super control (solo dueño) → /join/natmusicqr?super=1
        </p>
        <p>
          <Link href="/admin" className="text-zinc-500 hover:text-zinc-300">
            Admin de reglas →
          </Link>
        </p>
      </div>
    </div>
  )
}
