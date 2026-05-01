import type { Category } from './types.js';

export const CATEGORIES: Category[] = [
  {
    key: 'labor',
    name: 'Labor & Workers\' Rights',
    description: 'Content undermining worker protections, framing exploitation as freedom, or blaming workers for systemic conditions',
    researchQuery: `Focus: The erosion of labor protections and the normalization of worker exploitation.
    
    Dimensions to explore:
    - GIG ECONOMY: Misclassification as "entrepreneurship," opposition to AB5-style laws, "portable benefits" as a replacement for employment rights.
    - UNION BUSTING: "Right to work" advocacy, anti-union consultant materials, framing collective bargaining as "harmful to innovation."
    - WAGE STANDARDS: Opposition to minimum wage increases, arguments for "sub-minimum" wages, defenses of wage theft or tip-pooling changes.
    - CHILD LABOR: Rolling back age/hour restrictions, framing child work as "youth opportunity" or "character building."
    - POVERTY BLAMING: "Dependency" rhetoric, "welfare trap" arguments, pathologizing the working poor.
    - WORKPLACE SAFETY: Deregulation advocacy, framing safety standards as "red tape" that kills growth.`,
  },
  {
    key: 'economics',
    name: 'Economic Inequality & Propaganda',
    description: 'Supply-side mythology, billionaire worship, meritocracy myths, and corporate-funded policy laundering',
    researchQuery: `Focus: The legitimation of extreme wealth concentration and the promotion of regressive economic policy.
    
    Dimensions to explore:
    - TRICKLE-DOWN: "Tax cuts pay for themselves," Laffer curve revival, arguments against progressive taxation as "punitive."
    - BILLIONAIRE DEFENSE: Meritocracy myths, treating extreme wealth as purely "earned," framing wealth taxes as "theft."
    - CORPORATE WELFARE: Defending subsidies for profitable industries while opposing social spending.
    - MONOPOLY/ANTITRUST: Defending market concentration as "efficiency," opposing antitrust enforcement as "government overreach."
    - DEREGULATION: Counting gross costs of regulation without benefits, framing environmental/financial rules as "hidden taxes."
    - BUYBACKS/EPS: Defending stock buybacks over worker investment, justifying executive pay gaps.`,
  },
  {
    key: 'race',
    name: 'Racial Discrimination & Revisionism',
    description: 'Content promoting racial hierarchies, denying structural racism, or rehabilitating historical racial violence',
    researchQuery: `Focus: The denial of structural racism and the rehabilitation of racial hierarchies or historical violence.
    
    Dimensions to explore:
    - STRUCTURAL DENIAL: "Colorblindness" as a weapon against equity, framing DEI as "reverse racism," denying the racial wealth gap causes.
    - HISTORICAL REVISIONISM: "Lost Cause" narratives, Colonialism as "net positive," minimizing slavery or indigenous genocide.
    - PSEUDOSCIENCE: "Race and IQ" revivals, genetic determinism, "cultural" explanations for outcome gaps that omit policy.
    - ANTI-PROTEST: Criminalizing anti-racist movements, framing civil rights advocacy as "divisive" or "anti-American."
    - IMMIGRATION/RACE: Intersection of xenophobia and racial purity rhetoric, "demographic change" as a threat.`,
  },
  {
    key: 'gender',
    name: 'Gender & Sexual Discrimination',
    description: 'Misogyny, trans panic, conversion therapy defense, and pay gap denial packaged as commentary or advice',
    researchQuery: `Focus: The rolling back of gender equity and the targeting of LGBTQ+ people through policy and rhetoric.
    
    Dimensions to explore:
    - TRANS PANIC: "Protecting women's spaces" as a pretext for exclusion, medical misinformation about gender-affirming care.
    - MISOGYNY: "Traditional values" as a mask for subordination, "Red Pill" ideology in self-improvement/dating advice.
    - PAY GAP DENIAL: Attributing the gender wage gap purely to "choices" while ignoring structural barriers.
    - REPRODUCTIVE RIGHTS: Dehumanizing rhetoric in anti-abortion advocacy, framing reproductive healthcare as "immoral."
    - CONVERSION THERAPY: Defending debunked practices as "religious liberty" or "counseling freedom."`,
  },
  {
    key: 'immigration',
    name: 'Immigration & Xenophobia',
    description: 'Anti-immigrant rhetoric, demographic panic, and collective punishment of immigrant communities',
    researchQuery: `Focus: The dehumanization of immigrants and the framing of migration as a civilizational threat.
    
    Dimensions to explore:
    - REPLACEMENT THEORY: "Great Replacement" rhetoric, framing migration as an "invasion" or "surge."
    - CRIME/IMMIGRATION: Cherry-picking anecdotes to tie migration to criminality, omitting native-born crime rates.
    - ECONOMIC XENOPHOBIA: "Stealing jobs" myths, framing foreign workers as a burden on the social safety net.
    - DUE PROCESS EROSION: Defending mass detention, opposition to asylum laws, dehumanizing language in border policy.
    - NATIVISM: Defining national identity in exclusive ethnic/racial terms, framing assimilation as a "failure."`,
  },
  {
    key: 'religion',
    name: 'Religious Nationalism & Sectarian Discrimination',
    description: 'Christian nationalist policy advocacy, religious law imposition, and faith-based discrimination',
    researchQuery: `Focus: The imposition of religious doctrine on public law and the erosion of secular governance.
    
    Dimensions to explore:
    - CHRISTIAN NATIONALISM: "America as a Christian nation" revisionism, Seven Mountain Dominionism, Project Blitz.
    - WEAPONIZED LIBERTY: Using "religious freedom" to bypass anti-discrimination laws or labor standards.
    - THEOCRATIC POLICY: Scriptural arguments for secular legislation (e.g. anti-LGBTQ+ or anti-abortion laws).
    - ESTABLISHMENT CLAUSE: Pushing prayer or sectarian curriculum into public schools, public funding for religious institutions.
    - SECTARIAN BIAS: Framing pluralism as "persecution" of the majority religion.`,
  },
  {
    key: 'climate',
    name: 'Climate & Environmental Harm',
    description: 'Climate denial, fossil fuel greenwashing, and manufactured delay to climate action',
    researchQuery: `Focus: The delay of climate action through denial, greenwashing, or manufactured economic panic.
    
    Dimensions to explore:
    - GREENWASHING: "Net zero" claims paired with fossil fuel expansion, "bridge fuel" myths for natural gas.
    - DELAYISM: "Too expensive to act," "China/India first," catastrophizing the transition to renewables.
    - SCIENCE SKEPTICISM: Attacking climate models, cherry-picking temperature data, platforming contrarian "experts."
    - REGULATORY CAPTURE: Defending fossil fuel subsidies while attacking renewable energy incentives.
    - OFFSET MYTHS: Promoting unverified or temporary offsets as a substitute for real emissions cuts.`,
  },
  {
    key: 'health',
    name: 'Health Misinformation',
    description: 'Anti-vaccine propaganda, quackery targeting vulnerable people, and attacks on evidence-based medicine',
    researchQuery: `Focus: The erosion of trust in public health and the promotion of unproven or dangerous treatments.
    
    Dimensions to explore:
    - ANTI-VAX: Misrepresenting VAERS data, "gene therapy" mRNA myths, fabricating injury counts.
    - QUACKERY: "Natural cures" for serious diseases, supplement marketing without evidence, "detox" scams.
    - MEDICAL SKEPTICISM: Framing evidence-based medicine as purely a corporate "big pharma" conspiracy.
    - PUBLIC HEALTH ATTACKS: Opposition to masking, clean air standards, or community health initiatives as "tyranny."
    - DATA MANIPULATION: Overstating risks of treatment while minimizing risks of disease.`,
  },
  {
    key: 'democracy',
    name: 'Democracy & Political Rights',
    description: 'Voter suppression advocacy, authoritarian admiration, and normalization of anti-democratic erosion',
    researchQuery: `Focus: The erosion of democratic participation and the normalization of authoritarian governance.
    
    Dimensions to explore:
    - VOTER SUPPRESSION: "Election integrity" as a pretext for disenfranchisement, defending restrictive ID or ballot laws.
    - AUTHORITARIAN ADMIRATION: Praising foreign autocrats, framing "strongman" leadership as superior to deliberation.
    - DARK MONEY: Defending unlimited, anonymous spending as "free speech," opposing transparency laws.
    - JUDICIAL ACTIVISM: Defending the bypass of legislative/democratic processes through the courts.
    - NORM EROSION: Normalizing the refusal to accept election results or the use of state power against opponents.`,
  },
  {
    key: 'policing',
    name: 'Criminal Justice & Policing',
    description: 'Police brutality apologia, prison labor normalization, and opposition to accountability reforms',
    researchQuery: `Focus: The defense of state violence and the normalization of exploitative carceral systems.
    
    Dimensions to explore:
    - BRUTALITY APOLOGIA: "Split-second decision" defenses of excessive force, dehumanizing victims of police violence.
    - QUALIFIED IMMUNITY: Defending the bypass of accountability for state actors.
    - PRISON LABOR: Normalizing near-zero wage work as "discipline" or "rehabilitation," ALEC model legislation.
    - ACCOUNTABILITY OPPOSITION: Attacking civilian oversight, framing reform as the cause of "crime waves."
    - MASS INCARCERATION: Defending regressive sentencing, opposing bail reform, pathologizing over-policed communities.`,
  },
  {
    key: 'technology',
    name: 'Technology & Privacy',
    description: 'Surveillance normalization, social media harm denial, and AI ethics dismissal',
    researchQuery: `Focus: The normalization of digital surveillance and the dismissal of technological harms.
    
    Dimensions to explore:
    - SURVEILLANCE: "Nothing to hide" defenses of mass data collection, normalizing facial recognition/biometrics.
    - ALGORITHMIC BIAS: Dismissing documented bias in hiring/lending/policing as "innovation."
    - PLATFORM HARMS: Minimizing social media's impact on mental health or democracy, industry-funded denial.
    - AI ACCELERATIONISM: Dismissing safety and ethics concerns as "sci-fi hysteria" or "anti-progress."
    - DATA PRIVACY: Opposing legislative protection in favor of "self-regulation."`,
  },
  {
    key: 'disability',
    name: 'Disability Rights',
    description: 'Opposition to disability accommodations, ADA enforcement, or weaponization of disability as rhetoric',
    researchQuery: `Focus: The marginalization of disabled people and the framing of accessibility as an undue burden.
    
    Dimensions to explore:
    - ADA OPPOSITION: Framing accessibility lawsuits as "shakedowns," opposing compliance as "too expensive."
    - BENEFIT SKEPTICISM: Framing disability support as "enabling dependency," overstating fraud rates.
    - ABLEIST RHETORIC: Using disability as a political slur, pathologizing neurodivergence in the workplace.
    - EXCLUSION: Defending the denial of accommodations in education or employment under the banner of "merit."
    - MEDICAL MODEL: Prioritizing "cures" or "institutionalization" over community-based living and rights.`,
  },
  {
    key: 'war',
    name: 'War & Militarism',
    description: 'Warmongering, war crime denial, civilian harm minimization, and arms industry propaganda',
    researchQuery: `Focus: The normalization of military violence and the laundering of arms industry interests.
    
    Dimensions to explore:
    - HAWKISH PROPAGANDA: Advocating for military escalation without disclosing industry funding, "regime change" myths.
    - HARM MINIMIZATION: "Collateral damage" framing, using "precision strike" language to obscure civilian death.
    - WAR CRIME DENIAL: Dismissing documented atrocities as "fake" or "justified."
    - ARMS INDUSTRY PR: Laundering weapon sales as "jobs programs" or "global stability" initiatives.
    - MILITARIZATION: Normalizing the use of military hardware/tactics in domestic or civil contexts.`,
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
