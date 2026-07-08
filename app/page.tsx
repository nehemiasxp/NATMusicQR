import Link from 'next/link'

export default function Home() {
  return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col items-center justify-center px-6">
      <p className="text-emerald-400 text-xs tracking-[3px] uppercase font-medium">
        Jukebox colaborativo
      </p>
      <h1 className="text-4xl md:text-5xl font-bold mt-3 text-center">
        NATMusicQR
      </h1>
      <p className="text-zinc-400 mt-3 text-center max-w-md">
        Escanea el QR de tu mesa, elige una canción y suena en la TV del local.
      </p>

      <div className="mt-10 flex flex-col sm:flex-row gap-3 w-full max-w-sm">
        <Link
          href="/join/natmusicqr"
          className="flex-1 text-center rounded-full bg-emerald-600 hover:bg-emerald-500 font-semibold py-3.5"
        >
          Entrar como mesa
        </Link>
        <Link
          href="/player/natmusicqr"
          className="flex-1 text-center rounded-full border border-zinc-700 hover:border-zinc-500 py-3.5 text-zinc-200"
        >
          Pantalla TV
        </Link>
      </div>

      <div className="mt-12 text-xs text-zinc-600 space-y-1 text-center">
        <p>QR mesa 4 → /join/natmusicqr?mesa=4</p>
        <p>QR mesa 7 → /join/natmusicqr?mesa=7</p>
        <p>
          <Link href="/admin" className="text-zinc-500 hover:text-zinc-300">
            Admin de reglas →
          </Link>
        </p>
      </div>
    </div>
  )
}
