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
          <div className="space-y-2">
            <Row label="기기 고유 ID" value="익명 로그인 시 자동 발급되는 Firebase UID (학번·이름 등 개인 식별 정보와 무관)" />
            <Row label="닉네임 / 학과" value="사용자가 직접 입력 (임의 닉네임 허용, 실명 불필요)" />
            <Row label="FCM 푸시 토큰" value="알림 수신 동의 시 저장, 거부하면 수집하지 않음" />
            <Row label="연습 기록" value="알림 등록·해제 시각 기반 자동 계산 또는 사용자 직접 입력 (방 번호 포함 가능)" />
            <Row label="혼잡도 보고" value="층별 키오스크 대기 인원 숫자 (익명)" />
            <Row label="조기 반납 예고" value="층·반납 예정 시각 (기기 ID에 귀속, 닉네임 공개 여부는 사용자 선택)" />
            <Row label="시설 신문고" value="방 번호·내용 텍스트 (익명 제출 가능)" />
          </div>
        </section>

        <section>
          <h2 className="text-base font-bold text-gray-900 mb-3">2. 수집 목적</h2>
          <ul className="list-disc list-inside space-y-1 text-gray-600">
            <li>연습실 실시간 현황 공유 서비스 제공</li>
            <li>예약 알림·반납 리마인더 등 푸시 알림 발송</li>
            <li>연습 시간 통계 및 과별 랭킹 기능</li>
            <li>서비스 품질 개선 및 오류 분석</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-bold text-gray-900 mb-3">3. 보유 및 파기</h2>
          <p className="text-gray-600">
            서비스 이용 기간 동안 보유하며, 계정 삭제(설정 → 계정 삭제) 요청 시 30일 이내 모든 데이터를 파기합니다.
            혼잡도 보고는 제출 후 24시간이 지나면 자동으로 익명화됩니다.
          </p>
        </section>

        <section>
          <h2 className="text-base font-bold text-gray-900 mb-3">4. 제3자 제공 및 위탁</h2>
          <p className="text-gray-600 mb-3">
            수집한 정보는 외부에 판매하거나 제3자에게 제공하지 않습니다.
            서비스 운영을 위해 아래 업체에 처리를 위탁합니다.
          </p>
          <div className="space-y-2">
            <Row label="Google Firebase" value="익명 인증, 실시간 데이터베이스, 푸시 알림(FCM)" />
            <Row label="Supabase" value="연습 기록·랭킹 데이터 저장" />
            <Row label="Vercel" value="웹 서비스 호스팅" />
          </div>
        </section>

        <section>
          <h2 className="text-base font-bold text-gray-900 mb-3">5. 이용자 권리</h2>
          <ul className="list-disc list-inside space-y-1 text-gray-600">
            <li>수집 정보 열람·정정 요청 가능</li>
            <li>알림 수신 거부: 기기 설정 또는 앱 내 알림 설정에서 언제든 철회</li>
            <li>데이터 삭제: 아래 이메일로 기기 ID와 함께 요청</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-bold text-gray-900 mb-3">6. 문의</h2>
          <p className="text-gray-600">
            개인정보 관련 문의는{' '}
            <a href="mailto:pja571856@gmail.com" className="text-rb-600 font-medium underline">
              pja571856@gmail.com
            </a>
            으로 연락주세요.
          </p>
        </section>

      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-gray-50 px-4 py-3">
      <p className="text-xs font-bold text-gray-500 mb-0.5">{label}</p>
      <p className="text-gray-700">{value}</p>
    </div>
  )
}
