const ADJECTIVES = [
  '용감한', '느긋한', '씩씩한', '차분한', '활발한',
  '신중한', '따뜻한', '밝은', '유쾌한', '조용한',
  '열정적인', '진지한', '재치있는', '다정한', '강인한',
  '섬세한', '유연한', '대담한', '온화한', '명랑한',
  '부지런한', '여유로운', '진취적인', '상쾌한', '당찬',
]

const INSTRUMENTS = [
  '피아노', '첼로', '바이올린', '비올라', '플루트',
  '오보에', '클라리넷', '트럼펫', '호른', '타악기',
  '오르간', '하프', '트롬본', '튜바', '바순',
  '팀파니', '마림바', '색소폰', '콘트라베이스', '피콜로',
]

export function generateNickname(): string {
  const adj  = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const inst = INSTRUMENTS[Math.floor(Math.random() * INSTRUMENTS.length)]
  return `${adj} ${inst}`
}
