import Link from 'next/link';

export const metadata = {
  title: 'شاهدوا معاً',
  description: 'غرفة مشاهدة متزامنة لمشاركة اللحظات معاً.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'Watch With Me — شاهدوا معاً',
    description: 'غرفة مشاهدة متزامنة لمشاركة اللحظات معاً.',
    type: 'website' as const,
  },
  twitter: { card: 'summary' as const },
};

export default function HomePage() {
  return (
    <main className="landing">
      <header className="nav">
        <Link className="wordmark" href="/">
          WATCH <i>WITH</i> ME
        </Link>
        <span className="nav-note">غرفة واحدة · توقيت واحد</span>
        <Link className="text-link" href="/join">
          انضم إلى غرفة ←
        </Link>
      </header>
      <section className="hero">
        <div className="hero-copy">
          <p className="kicker">سينما، لكن بينكم</p>
          <h1>
            اضغط تشغيل.
            <br />
            <em>واجتمعوا.</em>
          </h1>
          <p className="lede">
            غرفة مشاهدة هادئة ومزامنة. شارك الرابط، واختبروا اللحظة نفسها — بلا شرح، بلا تأخير.
          </p>
          <div className="hero-actions">
            <Link className="button button-primary" href="/create">
              أنشئ غرفة مجانية <span aria-hidden="true">↗</span>
            </Link>
            <Link className="button button-ghost" href="/join">
              لديّ رابط غرفة
            </Link>
          </div>
          <p className="microcopy">لا حساب مطلوب · يعمل على الهاتف والكمبيوتر</p>
        </div>
        <div className="sync-orbit" aria-hidden="true">
          <div className="orbit-ring ring-one" />
          <div className="orbit-ring ring-two" />
          <div className="orbit-core">
            <span>SYNC</span>
            <strong>00:00</strong>
          </div>
          <div className="orbit-caption">LIVE</div>
        </div>
      </section>
      <section className="feature-strip">
        <div>
          <span className="feature-mark">01</span>
          <h2>نفس المشهد</h2>
          <p>تتبع الغرفة التشغيل والإيقاف والتقديم لحظة بلحظة.</p>
        </div>
        <div>
          <span className="feature-mark">02</span>
          <h2>أنت المضيف</h2>
          <p>تحكم واضح للمضيف، وتجربة مشاهدة بسيطة للضيوف.</p>
        </div>
        <div>
          <span className="feature-mark">03</span>
          <h2>خصوصية بلا ضجيج</h2>
          <p>الرابط يكفي. لا إعلانات، ولا ملفات شخصية معقدة.</p>
        </div>
      </section>
      <footer className="footer">
        <span>WWM / 2026</span>
        <span>صُممت للحظات التي تستحق أن تُشارك.</span>
      </footer>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebApplication',
            name: 'Watch With Me',
            description: 'غرفة مشاهدة متزامنة لمشاركة اللحظات معاً.',
            applicationCategory: 'EntertainmentApplication',
            operatingSystem: 'Web',
          }),
        }}
      />
    </main>
  );
}
