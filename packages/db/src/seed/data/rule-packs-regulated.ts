import type { SeedRulePack } from './rule-packs.js';

/* ==========================================================================
 * REGULATED-INDUSTRY PACKS — opt-in, jurisdictional, and honest about reach.
 *
 * These cannot be on by default. Failing a coffee brand against
 * financial-promotion rules is not a near miss, it is nonsense, and a tool
 * that cries wolf gets switched off along with the rules it was right about.
 * So every pack here ships `enabledByDefault: false` with an authority and a
 * jurisdiction attached, and a brand turns on the one that applies to it.
 *
 * WHAT THESE PACKS HONESTLY DO AND DO NOT DO
 *
 * A regulator's rulebook is written for humans and most of it is not
 * mechanically checkable. "Must not be socially irresponsible" has no
 * threshold. What the engine CAN do falls into three shapes, and every
 * template below is one of them:
 *
 *   MEASURED    prescribed wording is present verbatim, prohibited vocabulary
 *               is absent. Exact, cheap, and the strongest evidence available.
 *
 *   HYBRID      code finds the candidate language, a model decides whether it
 *               is actually a breach. `measuredBy` runs first and a clean pass
 *               short-circuits before any model call — so the cost falls only
 *               on the assets that mention something.
 *
 *   JUDGED      a rubric a model answers, for the rules that are genuinely
 *               semantic: does this link gambling to sexual success, does the
 *               person shown drinking appear under 25.
 *
 * None of this is legal advice and none of it is a substitute for review.
 * A pack that passes means the specific things it checks were not found — it
 * does not mean the asset is compliant, and the guidance on each rule says so
 * where somebody might otherwise assume otherwise. That is the difference
 * between a useful compliance tool and a liability.
 * ========================================================================== */

/* --------------------------------------------------------------------------
 * UK financial promotions — FCA COBS 4.12A
 *
 * The one regulated area with genuinely prescribed wording, which makes it the
 * one where a deterministic check is nearly conclusive. The FCA specifies the
 * risk warning for each instrument class VERBATIM, so "is this sentence
 * present" is the actual rule rather than a proxy for it.
 *
 * Each warning is a separate rule because a firm promotes one class, not all
 * four: `copy.required_terms` requires EVERY listed term, so one rule carrying
 * all four warnings would fail every promotion ever written. Activate the one
 * that matches what you sell.
 * ------------------------------------------------------------------------ */
const FCA_PROMOTIONS: SeedRulePack = {
  key: 'regulated-uk-financial-promotions',
  name: 'UK financial promotions (FCA)',
  description:
    'Prescribed risk warnings for high-risk investments, and the incentive-to-invest prohibition. Verbatim ' +
    'wording checks, so a pass here is close to conclusive for the warning itself.',
  category: 'regulated',
  enabledByDefault: false,
  jurisdictions: ['GB'],
  authority: 'Financial Conduct Authority — COBS 4.12A',
  docsUrl: 'https://handbook.fca.org.uk/handbook/COBS/4/12A.html',
  templates: [
    {
      key: 'fca.risk-warning.nrrs',
      statement:
        'A promotion of non-readily realisable securities must carry the prescribed risk warning verbatim: ' +
        '“Don’t invest unless you’re prepared to lose all the money you invest. This is a high-risk ' +
        'investment and you are unlikely to be protected if something goes wrong.”',
      rationale:
        'The FCA prescribes this wording exactly, which is unusual and useful: the rule is not "warn about ' +
        'risk", it is "say these words". A verbatim check is therefore the rule itself rather than a proxy ' +
        'for it, and a failure is unambiguous.',
      dimension: 'legal',
      tier: 'deterministic',
      severity: 'blocker',
      weight: 2,
      check: {
        fn: 'copy.required_terms',
        params: {
          terms: [
            'Don’t invest unless you’re prepared to lose all the money you invest. This is a high-risk investment and you are unlikely to be protected if something goes wrong.',
          ],
        },
      },
      satisfiedByParams: ['lexicon'],
      citation: { doc: 'FCA Handbook COBS 4.12A', instrument: 'non-readily realisable securities' },
      defaultStatus: 'proposed',
      guidance:
        'Activate only the warning for the instrument class you actually promote — the four warnings are ' +
        'alternatives, not a set. Note that this checks PRESENCE of the wording; the prominence rules ' +
        '(statically fixed at the top of a scrolling page, fixed on screen for the duration of a broadcast) ' +
        'are not measurable from the asset and still need a human.',
    },
    {
      key: 'fca.risk-warning.p2p',
      statement:
        'A promotion of P2P agreements must carry the prescribed risk warning verbatim: “Don’t invest ' +
        'unless you’re prepared to lose money. This is a high-risk investment. You may not be able to ' +
        'access your money easily and are unlikely to be protected if something goes wrong.”',
      rationale: 'Prescribed wording, checked verbatim. See the note on the NRRS warning.',
      dimension: 'legal',
      tier: 'deterministic',
      severity: 'blocker',
      weight: 2,
      check: {
        fn: 'copy.required_terms',
        params: {
          terms: [
            'Don’t invest unless you’re prepared to lose money. This is a high-risk investment. You may not be able to access your money easily and are unlikely to be protected if something goes wrong.',
          ],
        },
      },
      satisfiedByParams: ['lexicon'],
      citation: { doc: 'FCA Handbook COBS 4.12A', instrument: 'P2P agreements and portfolios' },
      defaultStatus: 'proposed',
      guidance: 'Activate this one only if you promote peer-to-peer lending. The four warnings are alternatives.',
    },
    {
      key: 'fca.risk-warning.cryptoassets',
      statement:
        'A cryptoasset promotion must carry the prescribed risk warning verbatim: “Don’t invest unless ' +
        'you’re prepared to lose all the money you invest. This is a high-risk investment and you should ' +
        'not expect to be protected if something goes wrong.”',
      rationale:
        'Note the wording differs from the securities warning by a few words — “should not expect to be ' +
        'protected” rather than “are unlikely to be protected”. Close enough that a human proofreading ' +
        'will not catch a substitution, which is exactly the case a machine check earns its place on.',
      dimension: 'legal',
      tier: 'deterministic',
      severity: 'blocker',
      weight: 2,
      check: {
        fn: 'copy.required_terms',
        params: {
          terms: [
            'Don’t invest unless you’re prepared to lose all the money you invest. This is a high-risk investment and you should not expect to be protected if something goes wrong.',
          ],
        },
      },
      satisfiedByParams: ['lexicon'],
      citation: { doc: 'FCA Handbook COBS 4.12A', instrument: 'qualifying cryptoassets' },
      defaultStatus: 'proposed',
      guidance: 'Activate this one only if you promote cryptoassets. The four warnings are alternatives.',
    },
    {
      key: 'fca.risk-warning.ltaf',
      statement:
        'A long-term asset fund promotion must carry the prescribed risk warning verbatim: “This is a ' +
        'high-risk investment, and assets may take a long time to buy and sell. Only invest if you can ' +
        'wait (possibly several years) to get your money back. You do not have protection against poor ' +
        'performance.”',
      rationale: 'Prescribed wording, checked verbatim. See the note on the NRRS warning.',
      dimension: 'legal',
      tier: 'deterministic',
      severity: 'blocker',
      weight: 2,
      check: {
        fn: 'copy.required_terms',
        params: {
          terms: [
            'This is a high-risk investment, and assets may take a long time to buy and sell. Only invest if you can wait (possibly several years) to get your money back. You do not have protection against poor performance.',
          ],
        },
      },
      satisfiedByParams: ['lexicon'],
      citation: { doc: 'FCA Handbook COBS 4.12A', instrument: 'long-term asset fund units' },
      defaultStatus: 'proposed',
      guidance: 'Activate this one only if you promote LTAF units. The four warnings are alternatives.',
    },
    {
      key: 'fca.no-investment-incentive',
      statement:
        'A promotion of a restricted mass market investment must not offer any monetary or non-monetary ' +
        'incentive to invest.',
      rationale:
        'The prohibition is on the incentive, not on the word — “bonus” in a promotion about staff bonuses ' +
        'is not a breach. So the vocabulary sweep finds candidates and a model decides whether what it ' +
        'found is actually an inducement to invest. A promotion mentioning none of the language never ' +
        'reaches the model, so the cost falls only where there is something to judge.',
      dimension: 'legal',
      tier: 'hybrid',
      severity: 'blocker',
      weight: 2,
      check: {
        fn: 'vlm.rule_adjudication',
        params: {
          measuredBy: 'copy.banned_terms',
          measureParams: {
            terms: [
              'sign-up bonus',
              'signup bonus',
              'welcome bonus',
              'refer a friend',
              'referral bonus',
              'cashback',
              'free shares',
              'free bitcoin',
              'free crypto',
              'risk-free',
              'guaranteed returns',
            ],
          },
          adjudicatePasses: false,
        },
      },
      rubric: {
        kind: 'binary',
        question:
          'Does this promotion offer the reader a monetary or non-monetary incentive to invest — a bonus, ' +
          'free shares, cashback or a referral reward conditional on investing?',
        passWhen: 'The flagged wording is not an inducement to invest (for example, it describes the product itself).',
        failWhen: 'An incentive conditional on investing is offered.',
        usePrecedents: true,
        cropTo: 'text',
      },
      citation: { doc: 'FCA Handbook COBS 4.12A', rule: 'incentives to invest' },
      guidance:
        'Extend the term list with the incentive language your own campaigns use. The model only sees ' +
        'assets where a term matched, so a longer list costs nothing on clean copy.',
    },
  ],
};

/* --------------------------------------------------------------------------
 * Alcohol — CAP Code Section 18
 *
 * Almost entirely semantic. "Must not link alcohol with seduction" is not a
 * threshold, and the rules that matter most — the age of the people shown, the
 * implication of social success — are visual judgements a person makes in a
 * second and no measurement makes at all. So this pack is mostly rubrics, and
 * says so.
 * ------------------------------------------------------------------------ */
const ALCOHOL: SeedRulePack = {
  key: 'regulated-uk-alcohol',
  name: 'Alcohol marketing (UK CAP Code)',
  description:
    'Section 18 of the CAP Code: social and sexual success, irresponsible drinking, alcoholic strength, ' +
    'driving, and the under-25 rule. Mostly model-judged, because these rules are about meaning.',
  category: 'regulated',
  enabledByDefault: false,
  jurisdictions: ['GB'],
  authority: 'Committee of Advertising Practice — CAP Code Section 18',
  docsUrl: 'https://www.asa.org.uk/type/non_broadcast/code_section/18.html',
  templates: [
    {
      key: 'alcohol.no-social-success',
      statement:
        'Marketing must not imply that alcohol can enhance confidence or popularity, or that it is ' +
        'essential to an occasion or a relationship.',
      rationale:
        'CAP 18.2 and 18.3. Sociable drinking may be shown; alcohol as the cause of the sociability may ' +
        'not. The distinction is exactly the kind a rubric can hold and a keyword cannot.',
      dimension: 'copy',
      tier: 'vlm',
      severity: 'blocker',
      weight: 2,
      check: { fn: 'vlm.subject_appropriateness', params: { sensitivities: ['UK CAP Code Section 18 — alcohol'] } },
      satisfiedByParams: ['image_style_profile'],
      rubric: {
        kind: 'binary',
        question:
          'Does this marketing imply that drinking alcohol makes people more confident, more popular, or ' +
          'that it is essential to the occasion or relationship shown? Showing people drinking sociably ' +
          'is permitted; implying the alcohol caused the sociability is not.',
        passWhen: 'Alcohol is present in a social scene without being presented as the cause of it.',
        failWhen: 'Confidence, popularity or the success of the occasion is attributed to the drink.',
        usePrecedents: true,
        cropTo: 'full',
      },
      citation: { doc: 'CAP Code', rules: ['18.2', '18.3'] },
      guidance:
        'The judgement is genuinely close on a lot of legitimate creative. Expect to review the first ' +
        'several verdicts — those decisions become the precedents that make the rest more accurate.',
    },
    {
      key: 'alcohol.no-seduction',
      statement:
        'Marketing must not link alcohol with seduction, sexual activity or sexual success, or imply it ' +
        'can enhance attractiveness.',
      rationale: 'CAP 18.5. One of the most frequently upheld complaints in the category.',
      dimension: 'imagery',
      tier: 'vlm',
      severity: 'blocker',
      weight: 2,
      check: {
        fn: 'vlm.subject_appropriateness',
        params: { sensitivities: ['UK CAP Code 18.5 — alcohol and sexual success'] },
      },
      satisfiedByParams: ['image_style_profile'],
      rubric: {
        kind: 'binary',
        question:
          'Does this marketing link alcohol to seduction, sexual activity or sexual success, or imply that ' +
          'drinking makes a person more attractive?',
        passWhen: 'No such link is made.',
        failWhen: 'Alcohol is presented as leading to, or accompanying, sexual success or attractiveness.',
        usePrecedents: true,
        cropTo: 'full',
      },
      citation: { doc: 'CAP Code', rules: ['18.5'] },
      guidance: 'Applies to imagery and copy together — the implication is usually carried by the pairing.',
    },
    {
      key: 'alcohol.under-25s',
      statement:
        'Nobody who is or appears under 25 may be shown drinking or playing a significant role. Under-25s ' +
        'may appear only where it is clear they are not drinking.',
      rationale:
        'CAP 18.16. A visual judgement about apparent age, which no measurement makes and which a person ' +
        'makes instantly — the clearest case in this pack for a model rather than a rule.',
      dimension: 'imagery',
      tier: 'vlm',
      severity: 'blocker',
      weight: 2,
      check: {
        fn: 'vlm.subject_appropriateness',
        params: { sensitivities: ['UK CAP Code 18.16 — apparent age of people shown with alcohol'] },
      },
      satisfiedByParams: ['image_style_profile'],
      rubric: {
        kind: 'binary',
        question:
          'Does anyone who appears to be under 25 drink alcohol, hold an alcoholic drink, or play a ' +
          'significant role in this marketing?',
        passWhen: 'Everyone drinking or in a significant role clearly appears 25 or over.',
        failWhen: 'Anyone who could reasonably be taken for under 25 is drinking or is central to the scene.',
        usePrecedents: true,
        cropTo: 'full',
      },
      citation: { doc: 'CAP Code', rules: ['18.16'] },
      guidance:
        'A model estimating apparent age is a screen, not a determination — treat a pass as "nothing ' +
        'obvious" rather than as clearance, and keep the model release paperwork that actually proves it.',
    },
    {
      key: 'alcohol.no-driving',
      statement: 'Marketing must not link alcohol with driving, or with operating machinery.',
      rationale:
        'CAP 18.12. Physical activity may be shown, but not as something undertaken after drinking. Cars ' +
        'and keys in an alcohol ad are the specific thing this catches.',
      dimension: 'imagery',
      tier: 'vlm',
      severity: 'blocker',
      weight: 2,
      check: {
        fn: 'imagery.prohibited_subject',
        params: { prohibitedSubjects: ['driving', 'car keys', 'operating machinery', 'boating', 'cycling'] },
      },
      satisfiedByParams: ['image_style_profile'],
      rubric: {
        kind: 'binary',
        question:
          'Does this marketing associate alcohol with driving, boating, cycling or operating machinery — ' +
          'including a vehicle, keys or a driving context appearing alongside the drink?',
        passWhen: 'No such association is present.',
        failWhen: 'Alcohol appears in a driving or machinery context, or an activity follows drinking.',
        usePrecedents: true,
        cropTo: 'full',
      },
      citation: { doc: 'CAP Code', rules: ['18.12'] },
      guidance: 'Add the vehicle and equipment types specific to your category to the subject list.',
    },
    {
      key: 'alcohol.no-strength-appeal',
      statement:
        'Alcoholic strength may be stated factually but must not be the principal appeal, and marketing ' +
        'must not imply a drink is preferable because of its intoxicating effect.',
      rationale:
        'CAP 18.9. Stating ABV is fine; selling on it is not, and the line between the two is in the ' +
        'framing. So the sweep finds strength language and the model decides which side it falls on.',
      dimension: 'copy',
      tier: 'hybrid',
      severity: 'major',
      weight: 1.5,
      check: {
        fn: 'vlm.rule_adjudication',
        params: {
          measuredBy: 'copy.banned_terms',
          measureParams: {
            terms: ['extra strong', 'strongest', 'high strength', 'triple distilled strength', 'maximum strength', 'hits harder', 'gets you there'],
          },
          adjudicatePasses: false,
        },
      },
      rubric: {
        kind: 'binary',
        question:
          'Is the alcoholic strength or intoxicating effect of this drink presented as a reason to choose ' +
          'it? A factual ABV statement is acceptable; strength as the selling point is not.',
        passWhen: 'Strength is stated factually or is incidental.',
        failWhen: 'Strength or intoxicating effect is the principal appeal.',
        usePrecedents: true,
        cropTo: 'text',
      },
      citation: { doc: 'CAP Code', rules: ['18.9'] },
      guidance:
        'Copy with none of the flagged language never reaches the model. Add your category’s own strength ' +
        'vocabulary to the list rather than relying on these examples.',
    },
  ],
};

/* --------------------------------------------------------------------------
 * Gambling — CAP Code Section 16
 *
 * The same shape as alcohol and for the same reason. Worth noting that 16.3.12
 * — strong appeal to under-18s — is under active ASA enforcement and is the
 * rule most gambling advertisers actually get caught by; it is also the least
 * mechanically checkable thing in this file, because "strong appeal" is a
 * judgement about who a piece of creative speaks to.
 * ------------------------------------------------------------------------ */
const GAMBLING: SeedRulePack = {
  key: 'regulated-uk-gambling',
  name: 'Gambling advertising (UK CAP Code)',
  description:
    'Section 16 of the CAP Code: appeal to under-18s, gambling as a financial solution, seduction and ' +
    'toughness framing, and the under-25 rule.',
  category: 'regulated',
  enabledByDefault: false,
  jurisdictions: ['GB'],
  authority: 'Committee of Advertising Practice — CAP Code Section 16',
  docsUrl: 'https://www.asa.org.uk/type/non_broadcast/code_section/16.html',
  templates: [
    {
      key: 'gambling.no-strong-appeal-to-minors',
      statement:
        'Marketing must not have strong appeal to under-18s, and must not feature anyone under 18 whose ' +
        'example under-18s would follow.',
      rationale:
        'CAP 16.3.12, and the rule the ASA has been enforcing most actively. "Strong appeal" turns on who ' +
        'the creative speaks to — cartoon styling, youth-culture references, a figure with a young ' +
        'following — which is a judgement about audience rather than a property of the file.',
      dimension: 'imagery',
      tier: 'vlm',
      severity: 'blocker',
      weight: 2,
      check: {
        fn: 'vlm.subject_appropriateness',
        params: { sensitivities: ['UK CAP Code 16.3.12 — strong appeal to under-18s'] },
      },
      satisfiedByParams: ['image_style_profile'],
      rubric: {
        kind: 'binary',
        question:
          'Would this marketing have strong appeal to people under 18 — through animation or cartoon ' +
          'styling, youth-culture references, video-game aesthetics, or a person with a strong following ' +
          'among under-18s? Judge appeal to under-18s specifically, not general appeal.',
        passWhen: 'Nothing in the creative is likely to appeal strongly to under-18s.',
        failWhen: 'Content, styling or a featured person is likely to appeal strongly to under-18s.',
        usePrecedents: true,
        cropTo: 'full',
      },
      citation: { doc: 'CAP Code', rules: ['16.3.12', '16.3.13'] },
      guidance:
        'This is a screen, not clearance. Media placement — where the ad runs and who it is targeted at — ' +
        'is half of the rule and is invisible to an asset check.',
    },
    {
      key: 'gambling.not-a-financial-solution',
      statement:
        'Marketing must not suggest gambling is a solution to financial concerns, an alternative to ' +
        'employment, or a route to financial security.',
      rationale:
        'CAP 16.3.4. The wording that triggers it is fairly stereotyped — "pay off your mortgage", "quit ' +
        'your job" — so a vocabulary sweep finds most of it, and the model rules on whether the framing ' +
        'actually makes the suggestion.',
      dimension: 'copy',
      tier: 'hybrid',
      severity: 'blocker',
      weight: 2,
      check: {
        fn: 'vlm.rule_adjudication',
        params: {
          measuredBy: 'copy.banned_terms',
          measureParams: {
            terms: [
              'quit your job',
              'pay off your mortgage',
              'financial freedom',
              'second income',
              'easy money',
              'get rich',
              'life-changing money',
              'clear your debts',
            ],
          },
          adjudicatePasses: false,
        },
      },
      rubric: {
        kind: 'binary',
        question:
          'Does this marketing suggest that gambling is a way to solve money problems, replace employment, ' +
          'or achieve financial security?',
        passWhen: 'No such suggestion is made.',
        failWhen: 'Gambling is framed as a financial solution or an alternative to earning.',
        usePrecedents: true,
        cropTo: 'text',
      },
      citation: { doc: 'CAP Code', rules: ['16.3.4'] },
      guidance:
        'Copy containing none of the flagged phrases never reaches the model, so extending the list is ' +
        'close to free. Add the phrasings your own campaigns and affiliates use.',
    },
    {
      key: 'gambling.no-seduction-or-toughness',
      statement:
        'Marketing must not link gambling to seduction, sexual success or attractiveness, nor present it ' +
        'in a context of toughness, resilience or recklessness.',
      rationale:
        'CAP 16.3.8 and 16.3.9, plus 16.3.6 on self-image. Three rules with one shape — gambling as a ' +
        'route to a better version of yourself — so they are judged together rather than as three near ' +
        'identical model calls on the same asset.',
      dimension: 'imagery',
      tier: 'vlm',
      severity: 'major',
      weight: 1.5,
      check: {
        fn: 'vlm.subject_appropriateness',
        params: { sensitivities: ['UK CAP Code 16.3.6, 16.3.8, 16.3.9 — gambling and self-image'] },
      },
      satisfiedByParams: ['image_style_profile'],
      rubric: {
        kind: 'binary',
        question:
          'Does this marketing link gambling to sexual success or attractiveness, to toughness or ' +
          'recklessness, or suggest it enhances self-image, self-esteem or control?',
        passWhen: 'Gambling is not presented as improving how the gambler is seen or how they see themselves.',
        failWhen: 'Any of those links is made.',
        usePrecedents: true,
        cropTo: 'full',
      },
      citation: { doc: 'CAP Code', rules: ['16.3.6', '16.3.8', '16.3.9'] },
      guidance:
        'Three code rules answered by one rubric. Fork it into separate rules if your compliance team ' +
        'needs findings cited to a single rule number.',
    },
    {
      key: 'gambling.under-25s',
      statement:
        'No child may appear, and nobody who is or appears under 25 may be shown gambling or in a ' +
        'significant role.',
      rationale: 'CAP 16.3.14. Apparent age again — the same visual judgement as the alcohol rule.',
      dimension: 'imagery',
      tier: 'vlm',
      severity: 'blocker',
      weight: 2,
      check: {
        fn: 'vlm.subject_appropriateness',
        params: { sensitivities: ['UK CAP Code 16.3.14 — apparent age of people shown gambling'] },
      },
      satisfiedByParams: ['image_style_profile'],
      rubric: {
        kind: 'binary',
        question:
          'Does anyone who appears to be under 25 gamble or play a significant role in this marketing? Do ' +
          'any children appear at all?',
        passWhen: 'Everyone shown gambling or in a significant role clearly appears 25 or over, and no children appear.',
        failWhen: 'Anyone who could be taken for under 25 gambles or is central, or a child appears.',
        usePrecedents: true,
        cropTo: 'full',
      },
      citation: { doc: 'CAP Code', rules: ['16.3.14'] },
      guidance:
        'A screen rather than a determination. Keep the model release paperwork that actually establishes age.',
    },
  ],
};

/* --------------------------------------------------------------------------
 * Food and health claims — Regulation (EC) 1924/2006
 *
 * The most mechanically checkable of the four after the FCA warnings, because
 * Article 10(2) prescribes accompanying statements and Article 12 prohibits
 * specific categories of claim outright.
 *
 * Retained in UK law after exit, so this pack carries both GB and the EU
 * member states rather than one or the other.
 * ------------------------------------------------------------------------ */
const HEALTH_CLAIMS: SeedRulePack = {
  key: 'regulated-eu-health-claims',
  name: 'Food and health claims (EU/UK 1924/2006)',
  description:
    'Article 10(2) accompanying statements, and the Article 12 prohibitions on health-harm framing, rate ' +
    'of weight loss, and individual practitioner endorsements.',
  category: 'regulated',
  enabledByDefault: false,
  jurisdictions: ['GB', 'IE', 'DE', 'FR', 'ES', 'IT', 'NL', 'BE', 'PL', 'SE', 'DK', 'FI', 'AT', 'PT'],
  authority: 'Regulation (EC) No 1924/2006 on nutrition and health claims made on foods',
  docsUrl: 'https://eur-lex.europa.eu/eli/reg/2006/1924/oj/eng',
  templates: [
    {
      key: 'health-claims.balanced-diet-statement',
      statement:
        'Any product making a health claim must also carry a statement on the importance of a varied and ' +
        'balanced diet and a healthy lifestyle.',
      rationale:
        'Article 10(2)(a). The one accompanying statement with reasonably settled wording, which makes it ' +
        'checkable as text. The other three — the quantity required for the effect, who should avoid the ' +
        'food, and an excess-consumption warning — are product-specific and cannot be checked as a fixed ' +
        'phrase.',
      dimension: 'legal',
      tier: 'deterministic',
      severity: 'blocker',
      weight: 2,
      check: { fn: 'copy.required_terms', params: { terms: ['varied and balanced diet'] } },
      satisfiedByParams: ['lexicon'],
      citation: { doc: 'Regulation (EC) 1924/2006', article: '10(2)(a)' },
      defaultStatus: 'proposed',
      guidance:
        'Scope this to the assets that actually make a health claim, or it will fail every asset you have. ' +
        'Article 10(2)(b)–(d) — quantity for the effect, who should avoid it, excess-consumption warning — ' +
        'are product-specific and are NOT checked here; they still need a person.',
    },
    {
      key: 'health-claims.no-rate-of-weight-loss',
      statement:
        'Marketing must not state or imply the rate or amount of weight loss a product produces, or that ' +
        'not eating it would harm health.',
      rationale:
        'Article 12(a) and 12(b), which are outright prohibitions rather than authorisation requirements — ' +
        'no evidence makes "lose 5kg in two weeks" permissible. The measured half finds the numeric and ' +
        'rate language, and the model rules on whether it is a weight-loss claim about the product.',
      dimension: 'legal',
      tier: 'hybrid',
      severity: 'blocker',
      weight: 2,
      check: {
        fn: 'vlm.rule_adjudication',
        params: {
          measuredBy: 'copy.banned_terms',
          measureParams: {
            terms: [
              'lose weight fast',
              'rapid weight loss',
              'drop a dress size',
              'burn fat fast',
              'lose up to',
              'shed pounds',
              'in just two weeks',
              'slimming',
            ],
          },
          adjudicatePasses: false,
        },
      },
      rubric: {
        kind: 'binary',
        question:
          'Does this copy state or imply how much weight, or how quickly, a person would lose by consuming ' +
          'the product — or suggest that not consuming it could harm their health?',
        passWhen: 'No rate or amount of weight loss is stated or implied, and no health-harm framing is used.',
        failWhen: 'Either is stated or implied.',
        usePrecedents: true,
        cropTo: 'text',
      },
      citation: { doc: 'Regulation (EC) 1924/2006', article: '12(a), 12(b)' },
      guidance:
        'These are absolute prohibitions — unlike most health claims, no substantiation makes them ' +
        'permissible, so a finding here is not a "get evidence" task.',
    },
    {
      key: 'health-claims.no-practitioner-endorsement',
      statement:
        'Marketing must not cite an endorsement by an individual doctor or health professional, or by an ' +
        'association that is not a recognised national body.',
      rationale:
        'Article 12(c). "Recommended by Dr —" is the stereotyped form and a vocabulary sweep catches it; ' +
        'whether an association qualifies is a judgement, which is the model’s half.',
      dimension: 'legal',
      tier: 'hybrid',
      severity: 'major',
      weight: 1.5,
      check: {
        fn: 'vlm.rule_adjudication',
        params: {
          measuredBy: 'copy.banned_terms',
          measureParams: {
            terms: [
              'recommended by doctors',
              'doctor recommended',
              'dentist recommended',
              'nutritionist approved',
              'endorsed by',
              'clinically proven',
              'as used by doctors',
            ],
          },
          adjudicatePasses: false,
        },
      },
      rubric: {
        kind: 'binary',
        question:
          'Does this copy cite a recommendation or endorsement by an individual medical or health ' +
          'professional, or by a health-related association that is not a recognised national body?',
        passWhen: 'No individual practitioner or non-qualifying association is cited as endorsing the product.',
        failWhen: 'Such an endorsement is cited.',
        usePrecedents: true,
        cropTo: 'text',
      },
      citation: { doc: 'Regulation (EC) 1924/2006', article: '12(c)' },
      guidance:
        'Endorsements by recognised national health associations and charities ARE permitted, which is ' +
        'why this is judged rather than blocked on the keyword alone.',
    },
    {
      key: 'health-claims.disease-risk-multifactor',
      statement:
        'A disease risk reduction claim must be accompanied by a statement that the disease has multiple ' +
        'risk factors and that altering one of them may or may not have a beneficial effect.',
      rationale:
        'Article 14(2). Prescribed in substance rather than verbatim, so this checks for the operative ' +
        'phrase rather than a full sentence — which means a pass tells you the statement is present, not ' +
        'that it is correctly worded for the claim being made.',
      dimension: 'legal',
      tier: 'deterministic',
      severity: 'blocker',
      weight: 2,
      check: { fn: 'copy.required_terms', params: { terms: ['multiple risk factors'] } },
      satisfiedByParams: ['lexicon'],
      citation: { doc: 'Regulation (EC) 1924/2006', article: '14(2)' },
      defaultStatus: 'proposed',
      guidance:
        'Scope this to assets that make a disease risk reduction claim. Matching an operative phrase is ' +
        'weaker evidence than the FCA verbatim checks — treat a pass as "the statement appears to be there".',
    },
  ],
};

export const REGULATED_RULE_PACKS: SeedRulePack[] = [FCA_PROMOTIONS, ALCOHOL, GAMBLING, HEALTH_CLAIMS];
