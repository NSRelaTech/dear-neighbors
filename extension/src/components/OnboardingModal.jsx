import { useState } from 'preact/hooks';
import { uiLanguage, setUiLanguage, t } from '../lib/i18n';
import { signInWithMagicLink } from '../store/auth';
import '../styles/onboarding-modal.css';
import '../styles/language.css';
import '../styles/auth-modal.css';

export function OnboardingModal({ onComplete }) {
  // NS fork: location is auto-set to Novi Sad, so onboarding is 2 steps —
  // step 1 = Language, step 2 = Account.
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  function chooseLanguage(lang) {
    setUiLanguage(lang);
    setStep(2);
  }

  function handleFinish() {
    localStorage.setItem('dn_onboarded', 'true');
    onComplete();
  }

  async function handleAuthSubmit(e) {
    e.preventDefault();
    if (!email.trim()) return;

    setError(null);
    setSending(true);
    const result = await signInWithMagicLink(email.trim());
    setSending(false);

    if (result.ok) {
      setSent(true);
    } else {
      setError(result.error);
    }
  }

  return (
    <div class="onboarding-overlay">
      <div class="onboarding-modal">
        <div class="onboarding-header">
          <h2 class="onboarding-title">{t('onboarding.welcome')}</h2>
          <p class="onboarding-subtitle">{t('onboarding.subtitle')}</p>
        </div>

        <div class="onboarding-progress">
          <span class={`onboarding-dot ${step >= 2 ? 'done' : 'active'}`} />
          <span class="onboarding-line">
            <span class={`onboarding-line-fill ${step >= 2 ? 'filled' : ''}`} />
          </span>
          <span class={`onboarding-dot ${step >= 2 ? 'active' : ''}`} />
        </div>

        <div class="onboarding-body">
          <div class="onboarding-steps">
            {/* Step 1: Language */}
            <section class="onboarding-step">
              <label class="onboarding-label">{t('onboarding.languageStep')}</label>
              <div class="lang-switch">
                <button
                  class={`lang-switch-option ${uiLanguage.value === 'en' ? 'active' : ''}`}
                  onClick={() => chooseLanguage('en')}
                >
                  <span class="lang-flag">{'🇬🇧'}</span>
                  English
                </button>
                <button
                  class={`lang-switch-option ${uiLanguage.value === 'sr' ? 'active' : ''}`}
                  onClick={() => chooseLanguage('sr')}
                >
                  <span class="lang-flag">{'🇷🇸'}</span>
                  Srpski
                </button>
              </div>
            </section>

            {/* Step 2: Account (optional) */}
            {step >= 2 && (
              <section class="onboarding-step">
                <label class="onboarding-label">{t('onboarding.accountStep')}</label>

                {sent ? (
                  <div class="auth-inline">
                    <div class="auth-sent">
                      <p>{t('auth.checkEmail')}</p>
                      <p class="auth-sent-email">{email}</p>
                      <p class="auth-spam-hint">{t('auth.spamHint')}</p>
                    </div>
                  </div>
                ) : (
                  <div class="auth-inline">
                    <form onSubmit={handleAuthSubmit}>
                      <input
                        type="email"
                        class="auth-input"
                        placeholder={t('auth.placeholder')}
                        value={email}
                        onInput={(e) => setEmail(e.target.value)}
                        required
                      />
                      {error && <p class="auth-error">{error}</p>}
                      <button type="submit" class="auth-submit" disabled={sending}>
                        {sending ? t('auth.sending') : t('auth.send')}
                      </button>
                    </form>
                  </div>
                )}
              </section>
            )}
          </div>

          {step >= 2 && (
            <button class="onboarding-cta" onClick={handleFinish}>
              {sent ? t('onboarding.getStarted') : t('onboarding.skipSignIn')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
