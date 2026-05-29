import Link from 'next/link'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: '개인정보처리방침 — 음대 연습실',
}

export default function PrivacyPage() {
  return (
    <div className="flex flex-col min-h-dvh max-w-md mx-auto bg-white px-5 pt-[calc(env(safe-area-inset-top)+24px)] pb-16">

      <Link href="/" className="text-rb-600 text-sm font-medium mb-6 inline-block">
        ← 돌아가기
      </Link>

      <h1 className="text-2xl font-bold text-gray-900 mb-1">개인정보처리방침</h1>
      <p className="text-xs text-gray-400 mb-8">최종 수정: 2026년 5월 29일</p>

      <div className="space-y-8 text-sm text-gray-700 leading-relaxed">

        <section>
          <h2 className="text-base font-bold text-gray-900 mb-3">1. 수집하는 정보</h2>
          <ul className="list-disc list-inside space-y-1 text-gray-600">
            <li>기기 고유 ID (익명, 학번·이름 등 개인 식별 정보 아님)</li>
            <li>닉네임 및 소속 학과 (사용자 직접 입력, 실명 불필요)</li>
            <li>푸시 알림 토큰 (알림 동의 시에만 수집)</li>
            <li>연습 기록 (알림 등록·해제 시각 기반 또는 직접 입력)</li>
            <li>혼잡도 보고 (층별 대기 인원 숫자, 익명)</li>
            <li>시설 신문고 내용 (익명 제출 가능)</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-bold text-gray-900 mb-3">2. 수집 목적</h2>
          <ul className="list-disc list-inside space-y-1 text-gray-600">
            <li>연습실 실시간 현황 공유 서비스 제공</li>
            <li>태그·반납 푸시 알림 발송</li>
            <li>연습 시간 통계 기능</li>
            <li>서비스 품질 개선</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-bold text-gray-900 mb-3">3. 보유 및 파기</h2>
          <p className="text-gray-600">
            서비스 이용 기간 동안 보유하며, 삭제 요청 시 30일 이내 파기합니다.
            혼잡도 보고는 제출 후 24시간이 지나면 자동으로 익명화됩니다.
          </p>
        </section>

        <section>
          <h2 className="text-base font-bold text-gray-900 mb-3">4. 제3자 제공</h2>
          <p className="text-gray-600">
            수집한 정보는 외부에 판매하거나 제3자에게 제공하지 않습니다.
            서비스 운영에 필요한 범위 내에서 클라우드 인프라 업체에 처리를 위탁합니다.
          </p>
        </section>

        <section>
          <h2 className="text-base font-bold text-gray-900 mb-3">5. 이용자 권리</h2>
          <ul className="list-disc list-inside space-y-1 text-gray-600">
            <li>수집 정보 열람·정정 요청 가능</li>
            <li>알림 수신 거부: 앱 내 알림 설정 또는 기기 설정에서 언제든 철회</li>
            <li>데이터 삭제: 앱 내 계정 메뉴에서 요청</li>
          </ul>
        </section>

      </div>
    </div>
  )
}
