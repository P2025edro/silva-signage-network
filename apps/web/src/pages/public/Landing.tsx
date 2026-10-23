import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, CheckCircle2, Clock, MapPin, MonitorPlay, PauseCircle, ShieldCheck, Smartphone, Upload } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { isSilva, useMe } from '@/lib/auth';
import { fmtEuro, fmtNumber } from '@/lib/format';
import type { Plan } from '@/lib/types';
import { Button, Checkbox, Field, Input, Notice, Select, Textarea } from '@/components/ui';

/** Shown if the API can't be reached, so the page never renders without prices. */
const FALLBACK_PLANS: Plan[] = [
  { id: 'starter', code: 'starter', name: 'Starter', monthlyPriceCents: 2900, currency: 'EUR', priceIsDraft: false, onlineCheckout: false, stripePriceId: null, entitlements: { max_screens: 1, max_active_campaigns: 1, monthly_playback_allocation: 3000, max_target_zones: 2 } },
  { id: 'business', code: 'business', name: 'Business', monthlyPriceCents: 5900, currency: 'EUR', priceIsDraft: false, onlineCheckout: false, stripePriceId: null, entitlements: { max_screens: 3, max_active_campaigns: 3, monthly_playback_allocation: 9000, max_target_zones: 5 } },
  { id: 'network-pro', code: 'network-pro', name: 'Network Pro', monthlyPriceCents: 9900, currency: 'EUR', priceIsDraft: false, onlineCheckout: false, stripePriceId: null, entitlements: { max_screens: 10, max_active_campaigns: 10, monthly_playback_allocation: 30000, max_target_zones: 20 } },
];

function Section({ id, eyebrow, title, children, dark }: { id?: string; eyebrow: string; title: string; children: ReactNode; dark?: boolean }) {
  return (
    <section id={id} className={dark ? 'bg-[#0c1218] text-[#f2f5f9]' : ''}>
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
        <p className={`text-xs font-bold tracking-[0.25em] uppercase ${dark ? 'text-[#4a9bea]' : 'text-accent'}`}>{eyebrow}</p>
        <h2 className="mt-3 max-w-3xl font-[family-name:var(--font-display)] text-3xl leading-tight font-extrabold sm:text-5xl">{title}</h2>
        <div className="mt-12">{children}</div>
      </div>
    </section>
  );
}

function TvMock() {
  return (
    <div aria-hidden className="relative mx-auto w-full max-w-xl">
      <div className="rounded-2xl bg-[#05080c] p-3 shadow-[0_30px_80px_-20px_rgba(17,97,185,0.55)] ring-1 ring-white/10">
        <div className="relative aspect-video overflow-hidden rounded-lg bg-gradient-to-br from-[#1161b9] to-[#0c1218]">
          <div className="absolute inset-0 flex flex-col justify-center gap-2 p-6 sm:p-10">
            <span className="text-[10px] font-bold tracking-[0.3em] text-white/70 uppercase sm:text-xs">Example advert</span>
            <span className="font-[family-name:var(--font-display)] text-2xl leading-tight font-extrabold text-white sm:text-4xl">Fresh fades,
              <br />every day</span>
            <span className="text-xs text-white/80 sm:text-sm">Barbershop · Camden Street · walk-ins welcome</span>
          </div>
          <div className="absolute right-3 bottom-3 rounded bg-black/40 px-2 py-1 text-[10px] text-white/80">2 / 6</div>
        </div>
      </div>
      <div className="mx-auto h-6 w-24 bg-[#05080c]" />
      <div className="mx-auto h-2 w-48 rounded-full bg-[#05080c]" />
    </div>
  );
}

export function LandingPage() {
  const { data: me } = useMe();
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => api.get<Plan[]>('/api/plans'), retry: 0 });
  const planList = plans.data?.length ? plans.data : FALLBACK_PLANS;

  return (
    <div className="min-h-dvh bg-canvas text-ink">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-line/70 bg-canvas/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3 sm:px-8">
          <a href="#top" className="flex items-center gap-3">
            <img src="/brand/silva-logo.png" alt="Silva Solutions Ltd" className="h-8 w-auto dark:hidden" />
            <img src="/brand/silva-logo-white.png" alt="Silva Solutions Ltd" className="hidden h-8 w-auto dark:block" />
            <span className="hidden border-l border-line pl-3 text-xs font-semibold tracking-[0.18em] text-accent uppercase sm:inline">Signage Network</span>
          </a>
          <nav className="flex items-center gap-1 text-sm">
            <a href="#how" className="hidden rounded-md px-3 py-2 text-muted hover:text-ink md:inline">How it works</a>
            <a href="#plans" className="hidden rounded-md px-3 py-2 text-muted hover:text-ink md:inline">Plans</a>
            {me ? (
              <Link to={isSilva(me) ? '/admin' : '/portal'}>
                <Button size="sm" variant="outline">Dashboard</Button>
              </Link>
            ) : (
              <Link to="/login" className="rounded-md px-3 py-2 text-muted hover:text-ink">Sign in</Link>
            )}
            <a href="#contact">
              <Button size="sm">Get started</Button>
            </a>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section id="top" className="relative overflow-hidden bg-[#0c1218] text-[#f2f5f9]">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_80%_10%,#16324f_0%,transparent_55%)]" />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 py-20 sm:px-8 sm:py-28 lg:grid-cols-[1.1fr_1fr]">
          <div>
            <p className="text-xs font-bold tracking-[0.25em] text-[#4a9bea] uppercase">Silva Signage Network · Dublin</p>
            <h1 className="mt-4 font-[family-name:var(--font-display)] text-4xl leading-[1.05] font-extrabold sm:text-6xl">
              Your TV. <br className="hidden sm:block" />
              Your neighbours’ customers.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-[#b8c6d6]">
              A shared screen network for local businesses. Your advert plays on TVs in other Dublin shops, cafés and salons — and theirs play on yours.
              Every advert is checked by Silva Solutions.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a href="#contact">
                <Button className="h-11 px-6 text-base">Book a free setup visit</Button>
              </a>
              <a href="#how">
                <Button variant="outline" className="h-11 border-white/20 bg-transparent px-6 text-base text-white hover:bg-white/10">
                  How it works
                </Button>
              </a>
            </div>
            <p className="mt-6 text-sm text-[#8fa3b8]">Plans from €29 a month · Runs on your Smart TV’s web browser</p>
          </div>
          <TvMock />
        </div>
      </section>

      {/* How it works */}
      <Section id="how" eyebrow="How it works" title="Live in four steps — no extra box to buy">
        <ol className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {[
            [MonitorPlay, 'Open the player', 'On your Smart TV’s web browser. It shows a short pairing code.'],
            [Smartphone, 'Pair it', 'Type the code into your Silva portal from your phone.'],
            [Upload, 'Upload your advert', 'An image or short video. Choose the areas and times it runs.'],
            [CheckCircle2, 'We approve it', 'Then it plays on screens across the network.'],
          ].map(([Icon, title, text], i) => {
            const I = Icon as typeof MonitorPlay;
            return (
              <li key={i} className="rounded-xl border border-line bg-surface p-6">
                <div className="flex items-center justify-between">
                  <I className="size-6 text-accent" aria-hidden />
                  <span className="font-[family-name:var(--font-display)] text-3xl font-extrabold text-accent/30">{i + 1}</span>
                </div>
                <h3 className="mt-4 font-semibold">{title as string}</h3>
                <p className="mt-1 text-sm leading-relaxed text-muted">{text as string}</p>
              </li>
            );
          })}
        </ol>
        <p className="mt-6 text-sm text-muted">We check your TV model during the setup visit. Most recent Samsung, LG and Android TVs have a built-in browser.</p>
      </Section>

      {/* Control */}
      <Section eyebrow="You stay in control" title="Your screen, your rules" dark>
        <div className="grid gap-5 sm:grid-cols-2">
          {[
            [ShieldCheck, 'No competitors on your screen', 'A barbershop can block other barbershops’ adverts. Choose exactly which kinds of business can appear.'],
            [CheckCircle2, 'Every advert checked', 'Silva Solutions reviews each advert before it reaches any screen.'],
            [Clock, 'Your hours, your areas', 'Run your campaign on chosen days and times, in the Dublin areas that matter to you.'],
            [PauseCircle, 'Pause any time', 'From your phone. Screens update within about a minute.'],
          ].map(([Icon, title, text], i) => {
            const I = Icon as typeof ShieldCheck;
            return (
              <div key={i} className="flex gap-4 rounded-xl border border-white/10 bg-white/[0.04] p-6">
                <I className="mt-0.5 size-6 shrink-0 text-[#4a9bea]" aria-hidden />
                <div>
                  <h3 className="font-semibold">{title as string}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-[#b8c6d6]">{text as string}</p>
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      {/* Reporting */}
      <Section eyebrow="Honest reporting" title="See exactly where your advert played">
        <div className="grid items-center gap-10 lg:grid-cols-2">
          <ul className="space-y-4 text-muted">
            <li className="flex gap-3"><BarChart3 className="size-5 shrink-0 text-accent" aria-hidden /> Daily playback for each campaign, by location and area.</li>
            <li className="flex gap-3"><MapPin className="size-5 shrink-0 text-accent" aria-hidden /> Know which venues your advert ran in.</li>
            <li className="flex gap-3"><CheckCircle2 className="size-5 shrink-0 text-accent" aria-hidden /> Counts come straight from the screens. We don’t invent “impressions”, and we never collect data about the people watching.</li>
          </ul>
          <div className="rounded-xl border border-line bg-surface p-6">
            <p className="text-sm font-semibold">Campaign report</p>
            <div className="mt-4 grid grid-cols-3 gap-3 text-center">
              {['Playback starts', 'Completed', 'Locations'].map((l) => (
                <div key={l} className="rounded-lg bg-subtle px-2 py-4">
                  <div className="font-[family-name:var(--font-display)] text-2xl font-extrabold text-ink/30">—</div>
                  <div className="mt-1 text-xs text-muted">{l}</div>
                </div>
              ))}
            </div>
            <p className="mt-4 text-xs text-muted">Your figures appear here once your campaign is live.</p>
          </div>
        </div>
      </Section>

      {/* Plans */}
      <section id="plans" className="border-y border-line bg-surface">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
          <p className="text-xs font-bold tracking-[0.25em] text-accent uppercase">Plans</p>
          <h2 className="mt-3 font-[family-name:var(--font-display)] text-3xl font-extrabold sm:text-5xl">One simple monthly subscription</h2>
          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {planList.map((p) => {
              const featured = p.code === 'business';
              const e = p.entitlements;
              return (
                <div key={p.code} className={`flex flex-col rounded-2xl p-7 ${featured ? 'bg-[#0c1218] text-[#f2f5f9] shadow-[0_20px_50px_-15px_rgba(17,97,185,0.5)]' : 'border border-line bg-canvas'}`}>
                  <div className="flex items-center justify-between">
                    <h3 className={`text-lg font-bold ${featured ? 'text-[#4a9bea]' : ''}`}>{p.name}</h3>
                    {featured && <span className="rounded-full bg-[#4a9bea]/15 px-2.5 py-0.5 text-xs font-semibold text-[#4a9bea]">Most popular</span>}
                  </div>
                  <p className="mt-4 font-[family-name:var(--font-display)] text-5xl font-extrabold">
                    {fmtEuro(p.monthlyPriceCents).replace(/[.,]00$/, '')}
                    <span className={`text-base font-medium ${featured ? 'text-[#8fa3b8]' : 'text-muted'}`}>/month</span>
                  </p>
                  <ul className={`mt-6 space-y-2.5 text-sm ${featured ? 'text-[#c3d0de]' : 'text-muted'}`}>
                    <li>✓ {e.max_screens === 1 ? '1 screen' : `Up to ${e.max_screens} screens`}</li>
                    <li>✓ {e.max_active_campaigns === 1 ? '1 active campaign' : `${e.max_active_campaigns} active campaigns`}</li>
                    <li>✓ Up to {fmtNumber(e.monthly_playback_allocation)} plays a month</li>
                    <li>✓ Target up to {e.max_target_zones} Dublin areas</li>
                    <li>✓ Reports, rules and approval included</li>
                  </ul>
                  <div className="flex-1" />
                  <a href={`#contact`} onClick={() => sessionStorage.setItem('ssn.plan', p.code)} className="mt-8">
                    <Button variant={featured ? 'primary' : 'outline'} className="w-full">Choose {p.name}</Button>
                  </a>
                </div>
              );
            })}
          </div>
          <p className="mt-6 text-sm text-muted">Plays depend on how many screens are in your chosen areas and when they’re switched on.</p>
        </div>
      </section>

      {/* FAQ */}
      <Section eyebrow="Questions" title="Good to know">
        <div className="grid gap-x-10 gap-y-8 md:grid-cols-2">
          {[
            ['Do I need to buy any equipment?', 'Usually not. The player runs in your Smart TV’s web browser. We check your TV during the setup visit and tell you straight away if it isn’t suitable.'],
            ['What appears on my screen?', 'Adverts from other participating local businesses, approved by Silva Solutions, plus your own rules about which kinds of business you allow.'],
            ['What if the internet drops?', 'The screen keeps showing the adverts it already has for a while, and catches up when the connection is back.'],
            ['Can I change my advert?', 'Yes. Upload a new image or video from your phone and submit it. Pause or cancel at any time.'],
            ['Who sees my details?', 'Only Silva Solutions. Other businesses see your advert, never your account information.'],
            ['Where does it run?', 'Participating businesses in Dublin, starting with Dublin 8, Portobello, Camden Street, Rathmines, Ranelagh, the city centre and Cabra.'],
          ].map(([q, a]) => (
            <div key={q}>
              <h3 className="font-semibold">{q}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{a}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* Contact */}
      <Section id="contact" eyebrow="Get started" title="Book a free setup visit" dark>
        <div className="grid gap-12 lg:grid-cols-[1fr_1.2fr]">
          <div className="space-y-4 text-[#b8c6d6]">
            <p>Tell us about your business and we’ll get back to you to arrange a visit. We’ll check your TV, pair it, and help you put your first advert live.</p>
            <p className="text-sm">Silva Solutions Ltd · Dublin, Ireland · silvasolutions.ie</p>
          </div>
          <ContactForm />
        </div>
      </Section>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-8 text-sm text-muted sm:px-8">
          <span>© {new Date().getFullYear()} Silva Solutions Ltd · Dublin</span>
          <span className="flex gap-4">
            <Link to="/privacy" className="hover:text-ink">Privacy</Link>
            <Link to="/login" className="hover:text-ink">Sign in</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}

function ContactForm() {
  const [f, setF] = useState(() => ({
    businessName: '',
    contactName: '',
    email: '',
    phone: '',
    area: '',
    businessType: '',
    screensEstimate: '1',
    interestedPlan: sessionStorage.getItem('ssn.plan') ?? 'not-sure',
    message: '',
    consent: false,
    website: '',
  }));
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setState('sending');
    try {
      await api.post('/api/public/leads', {
        ...f,
        phone: f.phone || null,
        area: f.area || null,
        businessType: f.businessType || null,
        message: f.message || null,
        screensEstimate: f.screensEstimate ? Number(f.screensEstimate) : null,
      });
      setState('sent');
    } catch (err) {
      setError(errorMessage(err));
      setState('idle');
    }
  }

  if (state === 'sent') {
    return (
      <div className="rounded-2xl bg-surface p-8 text-ink">
        <CheckCircle2 className="size-8 text-ok" aria-hidden />
        <h3 className="mt-4 text-xl font-bold">Thank you — we’ve got your details</h3>
        <p className="mt-2 text-muted">We’ll be in touch shortly to arrange your setup visit.</p>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="grid gap-4 rounded-2xl bg-surface p-6 text-ink sm:grid-cols-2 sm:p-8">
      {error && <div className="sm:col-span-2"><Notice tone="bad">{error}</Notice></div>}
      <Field label="Business name" htmlFor="l-biz">
        <Input id="l-biz" required value={f.businessName} onChange={(e) => set('businessName', e.target.value)} />
      </Field>
      <Field label="Your name" htmlFor="l-name">
        <Input id="l-name" required autoComplete="name" value={f.contactName} onChange={(e) => set('contactName', e.target.value)} />
      </Field>
      <Field label="Email" htmlFor="l-email">
        <Input id="l-email" type="email" required autoComplete="email" value={f.email} onChange={(e) => set('email', e.target.value)} />
      </Field>
      <Field label="Phone (optional)" htmlFor="l-phone">
        <Input id="l-phone" type="tel" autoComplete="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} />
      </Field>
      <Field label="Area" htmlFor="l-area">
        <Input id="l-area" placeholder="e.g. Rathmines" value={f.area} onChange={(e) => set('area', e.target.value)} />
      </Field>
      <Field label="Type of business" htmlFor="l-type">
        <Input id="l-type" placeholder="e.g. Café" value={f.businessType} onChange={(e) => set('businessType', e.target.value)} />
      </Field>
      <Field label="TVs on your premises" htmlFor="l-screens">
        <Select id="l-screens" value={f.screensEstimate} onChange={(e) => set('screensEstimate', e.target.value)}>
          <option value="0">None yet</option>
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3">3</option>
          <option value="5">4 or more</option>
        </Select>
      </Field>
      <Field label="Plan you’re interested in" htmlFor="l-plan">
        <Select id="l-plan" value={f.interestedPlan} onChange={(e) => set('interestedPlan', e.target.value)}>
          <option value="not-sure">Not sure yet</option>
          <option value="starter">Starter — €29/month</option>
          <option value="business">Business — €59/month</option>
          <option value="network-pro">Network Pro — €99/month</option>
        </Select>
      </Field>
      <Field label="Anything else? (optional)" htmlFor="l-msg" className="sm:col-span-2">
        <Textarea id="l-msg" value={f.message} onChange={(e) => set('message', e.target.value)} />
      </Field>
      {/* Honeypot: visually hidden, ignored by people */}
      <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="l-website">Website</label>
        <input id="l-website" tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => set('website', e.target.value)} />
      </div>
      <div className="sm:col-span-2">
        <Checkbox
          checked={f.consent}
          onChange={(v) => set('consent', v)}
          label={
            <span className="text-sm text-muted">
              Silva Solutions may contact me about Silva Signage Network. See our <Link to="/privacy" className="underline">privacy notice</Link>.
            </span>
          }
        />
      </div>
      <div className="sm:col-span-2">
        <Button type="submit" className="h-11 w-full text-base" loading={state === 'sending'} disabled={!f.consent}>
          Request my setup visit
        </Button>
      </div>
    </form>
  );
}

export function PrivacyPage() {
  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <div className="mx-auto max-w-2xl px-5 py-12">
        <Link to="/"><img src="/brand/silva-logo.png" alt="Silva Solutions Ltd" className="h-8 w-auto dark:hidden" /><img src="/brand/silva-logo-white.png" alt="Silva Solutions Ltd" className="hidden h-8 w-auto dark:block" /></Link>
        <h1 className="mt-10 font-[family-name:var(--font-display)] text-3xl font-extrabold">Privacy notice</h1>
        <div className="mt-6 space-y-4 text-sm leading-relaxed text-muted">
          <p><b className="text-ink">Who we are.</b> Silva Solutions Ltd, Dublin, Ireland, operates Silva Signage Network. Contact: [privacy contact email].</p>
          <p><b className="text-ink">Enquiries.</b> When you send the form on this website we keep your business name, your name, email, optional phone number and the details you give, only to contact you about Silva Signage Network. Legal basis: your consent and our legitimate interest in responding to you.</p>
          <p><b className="text-ink">Customer accounts.</b> For businesses that join, we keep account details, the adverts you upload and records of where adverts played, to run the service and bill for it.</p>
          <p><b className="text-ink">People watching the screens.</b> We collect nothing about them: no cameras, no audience measurement, no tracking.</p>
          <p><b className="text-ink">Cookies.</b> We use one essential cookie to keep you signed in. No advertising or analytics cookies.</p>
          <p><b className="text-ink">Sharing.</b> We use hosting, database and payment providers to run the service. We don’t sell your data.</p>
          <p><b className="text-ink">Your rights.</b> You can ask to see, correct or delete your data, or withdraw consent, by contacting us. You can also complain to the Data Protection Commission (dataprotection.ie).</p>
          <p className="text-xs">[Draft — to be reviewed before publication.]</p>
        </div>
      </div>
    </div>
  );
}
