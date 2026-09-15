const DEFAULT_UPSTREAM_API_URL = 'http://localhost:8000'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function upstreamApiUrl(): string {
  return (
    process.env.BOOKING_API_URL
    ?? process.env.NEXT_PUBLIC_BOOKING_API_URL
    ?? process.env.NEXT_PUBLIC_KIOSK_API_URL
    ?? DEFAULT_UPSTREAM_API_URL
  ).replace(/\/$/, '')
}

export async function POST(request: Request) {
  const authorization = request.headers.get('authorization')
  if (!authorization) {
    return Response.json({ detail: 'Google 로그인이 필요합니다.' }, { status: 401 })
  }

  try {
    const response = await fetch(`${upstreamApiUrl()}/identity/bind`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
      },
      body: await request.text(),
      cache: 'no-store',
      signal: AbortSignal.timeout(18000),
    })
    const body = await response.text()
    return new Response(body, {
      status: response.status,
      headers: {
        'content-type': response.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  } catch (cause) {
    console.error('identity bind upstream unavailable', cause)
    return Response.json(
      { detail: '연동 서버에 연결하지 못했어요. 저장된 학번을 유지한 채 자동으로 다시 시도합니다.' },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    )
  }
}
