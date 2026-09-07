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
      <p className="text-xs text-gray-400 mb-8">최종 수정: 2026년 9월 8일</p>

      <div className="space-y-8 text-sm text-gray-700 leading-relaxed">

        <section>
          <h2 className="text-base font-bold text-gray-900 mb-3">1. 수집하는 정보</h2>
          <ul className="list-disc list-inside space-y-1 text-gray-600">
            <li>Google 로그인 계정 식별자 및 예약을 위해 등록한 학번</li>
            <li>닉네임 및 소속 학과 (사용자 직접 입력, 실명 불필요)</li>
            <li>푸시 알림 토큰 (알림 동의 시), 찜한 방, 알림 설정 및 발송 기록</li>
            <li>라운지 텍스트 메시지, 발송 시각과 계정 연결 정보</li>
            <li>예약 기반 이용 기록 (방·예약 시각·인증 여부·처리 상태·반납 확인 시각) 및 기존 직접 입력·알림 기반 연습 기록</li>
            <li>혼잡도 보고 (층별 대기 인원 숫자, 익명)</li>
            <li>시설 신문고 내용 (익명 제출 가능)</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-bold text-gray-900 mb-3">2. 수집 목적</h2>
          <ul className="list-disc list-inside space-y-1 text-gray-600">
            <li>연습실 실시간 현황 공유 서비스 제공</li>
            <li>찜한 방의 공실 전환 및 태그·반납 푸시 알림 발송</li>
            <li>로그인한 학우 간 전체 라운지 대화 제공</li>
            <li>연습 시간 통계 기능</li>
            <li>서비스 품질 개선</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-bold text-gray-900 mb-3">3. 보유 및 파기</h2>
          <p className="text-gray-600">
            서비스 이용 기간 동안 보유하며, 삭제 요청 시 30일 이내 파기합니다.
            라운지 대화는 최대 7일 또는 최근 1,000개까지 보관하고, 알림 기록은 7일 후 삭제합니다. 찜과 알림 설정은 해제할 때까지, 갱신되지 않은 기기 토큰은 최대 60일 보관합니다.
          </p>
        </section>

        <section>
          <h2 className="text-base font-bold text-gray-900 mb-3">4. 제3자 제공</h2>
          <p className="text-gray-600">
            라운지 메시지는 로그인한 라운지 참여자에게 공개되며, 모든 작성자는 ‘익명’으로 표시됩니다. Google 이름·이메일·학번과 사용자별 별칭은 채팅 화면에 표시하지 않습니다. 메시지와 계정 연결 정보는 서비스 운영을 위해 서버에 보관합니다.
            서비스 운영에 필요한 범위 내에서 클라우드 인프라 업체에 처리를 위탁합니다.
          </p>
        </section>

        <section>
          <h2 className="text-base font-bold text-gray-900 mb-3">5. 이용자 권리</h2>
          <ul className="list-disc list-inside space-y-1 text-gray-600">
            <li>수집 정보 열람·정정 요청 가능</li>
            <li>알림 수신 거부: 앱 내 알림 설정 또는 기기 설정에서 언제든 철회</li>
            <li>데이터 삭제 문의: <a href="https://open.kakao.com/o/suKUBswi" target="_blank" rel="noopener noreferrer" className="underline">운영자 오픈채팅</a></li>
          </ul>
        </section>

      </div>
    </div>
  )
}
