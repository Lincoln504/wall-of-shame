import type { Category } from './types.js';

export const CATEGORIES: Category[] = [
  {
    key: 'labor',
    name: 'Labor & Workers\' Rights',
    description: 'Content undermining worker protections, framing exploitation as freedom, or blaming workers for systemic conditions',
    researchQuery: `Find content that harms workers' rights or normalizes exploitation. Cast a wide net — include obviously ideological sources AND neutrally-titled mainstream articles that contain harmful framing on closer inspection.

PASS 1 — obviously ideological sources:
- Union avoidance guides and "right to work" advocacy from business/HR publications
- Gig platform PR (Uber, Lyft, DoorDash) framing contractor misclassification as "flexibility"
- "Minimum wage kills jobs" arguments in think-tank reports
- Child labor law rollback advocacy framed as "youth opportunity"
- Welfare cuts justified by "dependency" framing

PASS 2 — neutrally-titled mainstream content to investigate:
- News coverage of labor disputes that frames employer talking points uncritically
- Business section articles about "the gig economy" that omit worker harm data
- Policy coverage of minimum wage debates that treats industry-funded studies as neutral
- "Work ethic" or "skills gap" explainers that implicitly blame workers for low wages
- Coverage of union elections that leads with company statements over worker voices
- Economics articles that discuss "labor market flexibility" without defining who bears the cost`,
  },
  {
    key: 'economics',
    name: 'Economic Inequality & Propaganda',
    description: 'Supply-side mythology, billionaire worship, meritocracy myths, and corporate-funded policy laundering',
    researchQuery: `Find content that defends extreme wealth, promotes trickle-down economics, or launders corporate interests as expert analysis. Include both openly ideological and neutrally-framed pieces.

PASS 1 — openly ideological:
- "Tax cuts pay for themselves" op-eds from Heritage, AEI, Cato, Tax Foundation
- Billionaire profiles in Forbes/Fortune treating wealth as purely merit-based
- "Wealth inequality isn't a problem" arguments using cherry-picked consumption data
- Dark money in politics defended as free speech
- "Anyone can succeed with hard work" meritocracy myths in business commentary

PASS 2 — neutrally-titled content to investigate:
- News articles about tax policy that present industry dynamic-scoring models without scrutiny
- "Economic growth" stories that use GDP without mentioning distribution
- Business journalism about stock buybacks that omits worker wage trade-offs
- Coverage of billionaire philanthropy that does not question tax avoidance underlying the wealth
- "What economists say about inequality" explainers that overweight pro-wealth academics
- Financial literacy content that attributes poverty to personal decisions rather than structural factors`,
  },
  {
    key: 'race',
    name: 'Racial Discrimination & Revisionism',
    description: 'Content promoting racial hierarchies, denying structural racism, or rehabilitating historical racial violence',
    researchQuery: `Find content that promotes racial hierarchy, blocks anti-racist remedies, or rewrites racialized history. Include fringe pseudoscience AND mainstream commentary with structural racism denial.

PASS 1 — overtly harmful:
- "Race and IQ" pseudoscience on American Renaissance, VDARE, or HBD blogs
- "Reverse racism" and "colorblind" anti-DEI op-eds
- Lost Cause / Confederate heritage defenses
- "British Empire was net positive" colonial revisionism
- Pipeline advocacy dismissing indigenous treaty rights

PASS 2 — neutrally-titled content to investigate:
- "Diversity in the workplace" coverage that frames DEI as unfair to white employees without evidence
- School curriculum articles that present "both sides" on whether slavery caused the Civil War
- Crime statistics reporting that correlates race with criminality without structural context
- College admissions coverage framing affirmative action as "racial preference" without historical context
- Business journalism about racial wealth gap that attributes it to savings behavior rather than redlining or discrimination
- "Cultural" explanations for outcome gaps that omit structural factors`,
  },
  {
    key: 'gender',
    name: 'Gender & Sexual Discrimination',
    description: 'Misogyny, trans panic, conversion therapy defense, and pay gap denial packaged as commentary or advice',
    researchQuery: `Find content that targets women, LGBTQ+ people, or denies gender-based discrimination. Look beyond obvious hate content to neutrally-framed pieces that normalize discrimination.

PASS 1 — overtly harmful:
- Red pill / incel ideology packaged as dating or self-improvement advice
- "Groomer" and "protect women's spaces" trans panic rhetoric
- Conversion therapy defended as religious or therapeutic freedom
- "Women choose lower-paying careers" pay gap denial

PASS 2 — neutrally-titled content to investigate:
- Workplace productivity articles that describe women's career interruptions without acknowledging structural causes
- "Science of sex differences" pieces that selectively cite biology to justify social inequality
- Sports journalism about trans athletes that presents debunked physiological claims as settled science
- Coverage of gender pay gap that uses "controlled" comparisons without explaining what's being controlled away
- Parenting or education content that reinforces rigid gender roles as natural
- Mental health coverage that pathologizes gender nonconformity without clinical basis`,
  },
  {
    key: 'immigration',
    name: 'Immigration & Xenophobia',
    description: 'Anti-immigrant rhetoric, demographic panic, and collective punishment of immigrant communities',
    researchQuery: `Find content that dehumanizes immigrants or frames immigration as an existential threat. Include explicit ethnonationalism AND mainstream coverage with embedded xenophobic framing.

PASS 1 — overtly harmful:
- "Great replacement" or "demographic change as civilizational threat" content
- "Islam is incompatible with democracy" Muslim collective punishment arguments
- "Immigrants cause crime" rhetoric using cherry-picked anecdotes
- Anti-refugee content framing asylum seekers as invaders

PASS 2 — neutrally-titled content to investigate:
- Border security news that uses "surge" and "invasion" language without attribution
- Immigration economics coverage that cites labor market displacement claims without peer-reviewed support
- Crime reporting that identifies suspect immigration status but not that of native-born defendants
- "Integration challenges" articles that frame cultural difference as inherent threat
- Policy coverage of immigration enforcement that omits due process and asylum law context
- News about visa programs that frames foreign workers as taking American jobs without economic evidence`,
  },
  {
    key: 'religion',
    name: 'Religious Nationalism & Sectarian Discrimination',
    description: 'Christian nationalist policy advocacy, religious law imposition, and faith-based discrimination',
    researchQuery: `Find content that pushes religious doctrine into law or frames secular governance as an attack on faith. Include explicit dominionism AND mainstream coverage that normalizes theocratic framing.

PASS 1 — overtly harmful:
- "America was founded as a Christian nation" constitutional revisionism
- Seven Mountain Dominionism and Project Blitz advocacy
- "Religious freedom" weaponized to impose Christian practices in public institutions
- Religious arguments for anti-LGBTQ+ legislation presented as neutral policy

PASS 2 — neutrally-titled content to investigate:
- Religious liberty coverage that frames any limit on faith-based discrimination as persecution
- School prayer debates that present "both sides" without engaging Establishment Clause precedent
- "Values voter" political coverage that treats theocratic policy goals as equivalent to secular ones
- Coverage of faith-based adoption agencies refusing same-sex couples that centers the agencies not the children
- "War on Christmas" or "anti-Christian bias" stories treating cultural pluralism as religious attack
- Policy journalism that treats scriptural arguments as valid policy evidence without noting their sectarian basis`,
  },
  {
    key: 'climate',
    name: 'Climate & Environmental Harm',
    description: 'Climate denial, fossil fuel greenwashing, and manufactured delay to climate action',
    researchQuery: `Find content that denies climate science, manufactures delay, or disguises polluters as environmental leaders. Include explicit denial AND neutrally-framed delay and greenwashing content.

PASS 1 — overtly harmful:
- Heartland Institute / CEI fossil-fuel-funded climate denial pieces
- "The models are always wrong" delay arguments
- "Net zero will destroy the economy" catastrophizing without alternatives
- ExxonMobil / Shell net-zero advertising while lobbying against regulation

PASS 2 — neutrally-titled content to investigate:
- Energy journalism covering natural gas as a "bridge fuel" without lifecycle emissions data
- Business coverage of carbon offsets that does not scrutinize additionality or permanence
- "Both sides" climate coverage that quotes a single contrarian against scientific consensus
- Technology journalism about carbon capture that presents it as a substitute for emissions reduction
- Financial coverage of fossil fuel investment that omits stranded-asset and climate risk
- Agriculture or industry news that frames environmental regulation as purely a cost without benefit analysis`,
  },
  {
    key: 'health',
    name: 'Health Misinformation',
    description: 'Anti-vaccine propaganda, quackery targeting vulnerable people, and attacks on evidence-based medicine',
    researchQuery: `Find content that spreads dangerous health misinformation or markets unproven treatments. Include explicit anti-vaccine content AND neutrally-framed pieces that undermine public health.

PASS 1 — overtly harmful:
- VAERS data misrepresentation to fabricate vaccine injury counts
- RFK Jr., Mercola, or similar anti-vax influencer content
- "Cure cancer naturally" supplement and alternative therapy marketing
- COVID conspiracy content (depopulation, microchip, mRNA gene editing)

PASS 2 — neutrally-titled content to investigate:
- Health journalism covering vaccine hesitancy that platforms anti-vax voices as "balance"
- Wellness content promoting unproven supplements without citing lack of clinical evidence
- "Natural health" articles that frame pharmaceutical medicine as inherently corporate and dangerous
- Mental health coverage that promotes unproven treatments alongside evidence-based ones without distinction
- Coverage of medical studies that overstates findings or ignores sample size and replication issues
- "Alternative medicine" explainers that present anecdote as equivalent to clinical trial data`,
  },
  {
    key: 'democracy',
    name: 'Democracy & Political Rights',
    description: 'Voter suppression advocacy, authoritarian admiration, and normalization of anti-democratic erosion',
    researchQuery: `Find content that restricts democratic participation, praises authoritarian governance, or erodes democratic norms. Include explicit anti-democratic advocacy AND neutrally-framed normalization.

PASS 1 — overtly harmful:
- Heritage Foundation "election integrity" voter suppression advocacy
- Tucker Carlson / Orbán admiration pieces
- "Strong executive power" arguments for judicial bypass
- Citizens United dark money defenses

PASS 2 — neutrally-titled content to investigate:
- Election coverage that treats unsubstantiated fraud claims as equally credible to election administration evidence
- Voter ID coverage that cites "common sense" without engaging documented disenfranchisement data
- Political journalism that describes authoritarian leaders as "strongmen" admiringly or without challenge
- "Gridlock" framing that implies democratic deliberation is dysfunction requiring executive override
- Coverage of court-packing or norm violations that treats "both sides do it" as accurate without evidence
- Campaign finance journalism that presents unlimited dark money as simply "free speech" without corruption context`,
  },
  {
    key: 'policing',
    name: 'Criminal Justice & Policing',
    description: 'Police brutality apologia, prison labor normalization, and opposition to accountability reforms',
    researchQuery: `Find content that defends police misconduct, opposes accountability, or normalizes prison exploitation. Include explicit apologia AND neutrally-framed coverage that buries accountability.

PASS 1 — overtly harmful:
- "Officer had no choice" defenses in documented excessive-force cases
- Qualified immunity defense pieces
- "Prison labor teaches discipline" defenses of near-zero wage forced work
- ALEC model legislation supporting prison labor expansion

PASS 2 — neutrally-titled content to investigate:
- Crime reporting that leads with police narrative without independent verification or victim account
- Coverage of police reform proposals that foregrounds officer safety objections without engaging reform evidence
- Prison journalism that describes labor programs as "rehabilitation" without examining wages or voluntariness
- "Law and order" political coverage that equates protest with criminality without legal distinction
- Sentencing or incarceration data coverage that uses raw numbers without racial disparity context
- "Police staffing shortage" stories that frame any accountability measure as the cause`,
  },
  {
    key: 'technology',
    name: 'Technology & Privacy',
    description: 'Surveillance normalization, social media harm denial, and AI ethics dismissal',
    researchQuery: `Find content that normalizes surveillance, minimizes tech harms, or argues against accountability for tech companies. Include explicit dismissals AND neutrally-framed content that buries harms.

PASS 1 — overtly harmful:
- "Nothing to hide" surveillance defense articles
- "Social media doesn't cause teen depression" industry-funded studies
- "AI safety is sci-fi hysteria" dismissal pieces from effective accelerationism

PASS 2 — neutrally-titled content to investigate:
- Smart city or public safety tech journalism that presents facial recognition without accuracy or bias data
- AI coverage that discusses capabilities without mentioning documented bias in hiring, lending, or criminal justice
- Social media platform coverage that cites engagement metrics as user satisfaction without wellbeing data
- Data privacy journalism that presents industry self-regulation as equivalent to legislative protection
- "Innovation" coverage of surveillance tech that omits use-case abuse documented in FOIA records
- Platform content moderation coverage that treats any moderation as equivalent censorship to government speech restrictions`,
  },
  {
    key: 'disability',
    name: 'Disability Rights',
    description: 'Opposition to disability accommodations, ADA enforcement, or weaponization of disability as rhetoric',
    researchQuery: `Find content that frames disability rights as excessive burden or uses disability rhetorically. Include explicit opposition AND neutrally-framed coverage that marginalizes disabled people.

PASS 1 — overtly harmful:
- "ADA lawsuits are shakedowns" business opposition to accessibility
- Articles opposing disability benefits as enabling dependency
- Using "mentally ill" or cognitive disability as political insult

PASS 2 — neutrally-titled content to investigate:
- Workplace productivity coverage that frames neurodivergent accommodation as competitive disadvantage
- Education journalism about "merit" that omits how disability accommodations are denied or under-resourced
- Health policy coverage of disability benefits that uses "fraud" framing without base-rate context
- "Participation trophy" culture commentary that implicitly targets disability accommodations
- Business coverage of ADA compliance costs that does not weigh against benefits to disabled employees and customers
- Coverage of disability employment statistics that attributes gaps to individual capability rather than structural barriers`,
  },
  {
    key: 'war',
    name: 'War & Militarism',
    description: 'Warmongering, war crime denial, civilian harm minimization, and arms industry propaganda',
    researchQuery: `Find content that normalizes military violence, denies or minimizes war crimes, or launders arms industry interests. Include explicit hawkish propaganda AND neutrally-framed coverage that sanitizes military harm.

PASS 1 — overtly harmful:
- Arms industry funded think tanks (CSIS, CNAS, Atlantic Council) advocating military escalation without disclosing funders
- "Collateral damage" framing in op-eds minimizing civilian casualties
- War crime denial for documented atrocities
- "Regime change is necessary" content ignoring historical failure record

PASS 2 — neutrally-titled content to investigate:
- Defense budget journalism that uses military framing ("readiness," "capability gap") without independent analysis
- War coverage that cites military body counts without civilian casualty data from independent monitors
- "National security" op-eds that treat military escalation as the only policy option
- Arms sales coverage that describes weapons transfers without end-use and civilian harm context
- Coverage of drone programs that uses official "precision strike" language without independent casualty verification
- Veterans affairs journalism that centers military institution reputation over veteran harm outcomes`,
  },
];

export function getBatch(index: number, size: number = 3): Category[] {
  const start = index % CATEGORIES.length;
  const result: Category[] = [];
  for (let i = 0; i < size; i++) {
    result.push(CATEGORIES[(start + i) % CATEGORIES.length]!);
  }
  return result;
}

export const CATEGORY_COUNT = CATEGORIES.length;
