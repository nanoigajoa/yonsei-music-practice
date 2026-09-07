import { ImageResponse } from 'next/og'
export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params
  const size = ({ 'icon-192x192.png': 192, 'icon-512x512.png': 512, 'icon-96x96.png': 96 } as Record<string, number>)[file]
  if (!size) return new Response('Not found', { status: 404 })
  return new ImageResponse(<div style={{ width: '100%', height: '100%', display: 'flex', background: '#2563eb', alignItems: 'center', justifyContent: 'center' }}>
    <div style={{ display: 'flex', position: 'relative', width: size*.5, height: size*.55 }}>
      <div style={{ position: 'absolute', display: 'flex', width: size*.08, height: size*.4, background: 'white', right: size*.08, top: 0, borderRadius: size*.03 }} />
      <div style={{ position: 'absolute', display: 'flex', width: size*.27, height: size*.18, background: 'white', right: size*.08, bottom: 0, borderRadius: size*.1 }} />
      <div style={{ position: 'absolute', display: 'flex', width: size*.23, height: size*.08, background: 'white', right: -size*.07, top: size*.01, transform: 'rotate(20deg)', borderRadius: size*.03 }} />
    </div>
  </div>, { width: size, height: size, headers: { 'Cache-Control': 'public, max-age=86400' } })
}
