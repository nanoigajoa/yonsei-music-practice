'use client'
import { useEffect, useState } from 'react'
import { User } from 'firebase/auth'
import { useFcmToken } from '@/hooks/useFcmToken'

function IOSGuideModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 px-4 pb-[calc(env(safe-area-inset-bottom)+16px)]">
      <div className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl">
        <h3 className="text-lg font-bold text-gray-900 mb-5">📱 iOS에서 알림 받는 방법</h3>
        <ol className="space-y-4">
          {[
            '하단 공유 버튼(□↑)을 탭하세요',
            '"홈 화면에 추가"를 선택하세요',
            '홈 화면의 앱 아이콘으로 실행 후 알림을 켜세요',
          ].map((text, i) => (
            <li key={i} className="flex gap-3 items-start">
              <span className="flex-shrink-0 w-7 h-7 rounded-full bg-rb-600 text-white text-sm font-bold flex items-center justify-center">
                {i + 1}
              </span>
              <span className="text-sm text-gray-700 pt-1">{text}</span>
            </li>
          ))}
        </ol>
        <button
          onClick={onClose}
          className="mt-6 w-full h-13 rounded-2xl bg-rb-600 text-white text-sm font-bold active:scale-[0.98] transition-all"
        >
          알겠어요
        </button>
      </div>
    </div>
  )
}

export function NotificationBanner({ user }: { user: User | null }) {
  const { permission, requestAndRegister } = useFcmToken(user)
  const [dismissed, setDismissed] = useState(false)
  const [isIOS, setIsIOS] = useState(false)
  const [isStandalone, setIsStandalone] = useState(false)
  const [showIOSModal, setShowIOSModal] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as any).standalone === true
    setIsIOS(ios)
    setIsStandalone(standalone)
  }, [])

  if (permission === 'granted' || dismissed) return null

  async function handleEnable() {
    if (isIOS && !isStandalone) {
      setShowIOSModal(true)
      return
    }
    setLoading(true)
    await requestAndRegister()
    setLoading(false)
  }

  return (
    <>
      <div className="mx-4 mt-3 rounded-2xl bg-rb-600 px-4 py-3.5">
        {permission === 'denied' ? (
          <p className="text-sm text-rb-100 font-medium">
            브라우저 설정에서 알림을 허용해야 태그 망각 알림을 받을 수 있어요.
          </p>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-white">태그 망각 방지 알림</p>
              <p className="text-xs text-rb-200 mt-0.5 truncate">예약 후 10분 내 태그 시간을 알려드려요</p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => setDismissed(true)}
                className="text-xs text-rb-300 px-2 py-1 font-medium"
              >
                나중에
              </button>
              <button
                onClick={handleEnable}
                disabled={loading}
                className="text-xs font-bold bg-white text-rb-600 px-3.5 py-2 rounded-xl disabled:opacity-60 active:scale-95 transition-all"
              >
                {loading ? '...' : '켜기'}
              </button>
            </div>
          </div>
        )}
      </div>

      {showIOSModal && <IOSGuideModal onClose={() => setShowIOSModal(false)} />}
    </>
  )
}
