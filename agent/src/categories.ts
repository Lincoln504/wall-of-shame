import type { Category } from './types.js';

export const CATEGORIES: Category[] = [
  {
    key: 'labor',
    name: 'Labor & Workers\' Rights',
    description: 'Content undermining worker protections, framing exploitation as freedom, or blaming workers for systemic conditions',
    researchQuery: `Find articles, op-eds, corporate PR, and think-tank pieces that attack worker rights, unions, or labor protections — or that frame exploitation as empowerment.

Research these angles:
- Union avoidance guides and "right to work" advocacy
- Gig platform PR framing contractor misclassification as "flexibility"
- "Minimum wage kills jobs" arguments ignoring contrary evidence
- Child labor law rollback advocacy framed as "opportunity"
- "Bootstraps" content blaming poverty on personal failure rather than systemic causes
- Welfare cuts framed as fighting "dependency"
- Arguments that workers are better off without collective bargaining`,
  },
  {
    key: 'economics',
    name: 'Economic Inequality & Propaganda',
    description: 'Supply-side mythology, billionaire worship, meritocracy myths, and corporate-funded policy laundering',
    researchQuery: `Find articles, think-tank reports, and op-eds that promote trickle-down economics, defend extreme wealth concentration, deny inequality, or launder corporate interests as independent expert analysis.

Research these angles:
- "Tax cuts pay for themselves" supply-side cheerleading
- Billionaire profiles celebrating wealth as purely deserved merit
- "Wealth inequality isn't real" arguments using misleading metrics
- Corporate-funded think tanks presenting industry positions as neutral research
- Dark money in politics defended as free speech without acknowledging corruption
- "Anyone can make it with hard work" meritocracy myths ignoring structural barriers
- Capital gains tax cuts framed as helping workers`,
  },
  {
    key: 'race',
    name: 'Racial Discrimination & Revisionism',
    description: 'Content promoting racial hierarchies, denying structural racism, or rehabilitating historical racial violence',
    researchQuery: `Find articles, academic-adjacent content, and op-eds that use pseudoscience to argue racial hierarchies, invoke colorblindness to block anti-racism, rehabilitate colonial or Confederate history, or deny indigenous rights.

Research these angles:
- "Race and IQ" pseudoscience on American Renaissance or HBD blogs
- "Reverse racism" and "colorblind" anti-DEI arguments
- "MLK would oppose affirmative action" history misappropriation
- "British Empire was good actually" and colonial revisionism
- Lost Cause / Confederate heritage defenses
- Pipeline advocacy dismissing treaty violations with indigenous nations
- "Systemic racism doesn't exist" arguments opposing structural remedies`,
  },
  {
    key: 'gender',
    name: 'Gender & Sexual Discrimination',
    description: 'Misogyny, trans panic, conversion therapy defense, and pay gap denial packaged as commentary or advice',
    researchQuery: `Find content that dehumanizes women, targets trans people with manufactured fear, defends conversion therapy, or denies gender-based discrimination.

Research these angles:
- Red pill / incel ideology packaged as dating advice or men's rights
- "Women choose lower-paying jobs" pay gap denial ignoring why those choices occur
- "Groomer" and "protect women's spaces" trans panic rhetoric without evidence
- "Detransition" stories weaponized against gender-affirming care
- Conversion therapy defended as religious freedom
- "Women belong in traditional roles" dressed as lifestyle content`,
  },
  {
    key: 'immigration',
    name: 'Immigration & Xenophobia',
    description: 'Anti-immigrant rhetoric, demographic panic, and collective punishment of immigrant communities',
    researchQuery: `Find articles and commentary that frame immigration as an existential demographic threat, promote replacement theory, advocate collective punishment of immigrant groups, or use fear of crime and terrorism to dehumanize migrants.

Research these angles:
- "Great replacement" or "demographic change as civilizational threat" content
- "Islam is incompatible with democracy" Muslim collective punishment arguments
- "Immigrants cause crime" rhetoric using cherry-picked data
- Anti-refugee content framing asylum seekers as invaders
- "Illegal alien" dehumanization in policy advocacy
- Border panic content without context of root causes or asylum law
- Travel ban and Muslim ban defenses`,
  },
  {
    key: 'religion',
    name: 'Religious Nationalism & Sectarian Discrimination',
    description: 'Christian nationalist policy advocacy, religious law imposition, and faith-based discrimination',
    researchQuery: `Find articles and advocacy content that argue the US is or should be a Christian nation, push to encode religious doctrine into law, or promote faith-based discrimination against religious minorities and LGBTQ+ people.

Research these angles:
- "America was founded as a Christian nation" constitutional revisionism
- Seven Mountain Dominionism and Project Blitz advocacy
- "Religious freedom" as cover to impose Christian practices in public institutions
- Opposition to church-state separation framed as protecting Christianity
- "Secularism is an attack on Christianity" persecution complex content
- Religious arguments for anti-LGBTQ+ legislation presented as neutral policy`,
  },
  {
    key: 'climate',
    name: 'Climate & Environmental Harm',
    description: 'Climate denial, fossil fuel industry greenwashing, and manufactured delay to climate action',
    researchQuery: `Find articles, think-tank content, and corporate PR that deny climate science, manufacture delay to climate action, or disguise polluters as environmental leaders.

Research these angles:
- Heartland Institute / CEI fossil-fuel-funded climate denial
- "The models are always wrong" delay arguments
- "Net zero will destroy the economy" catastrophizing without context
- ExxonMobil / Shell / BP "clean energy" advertising while lobbying against regulation
- "Natural gas is clean" industry messaging
- Plastic industry "recycling is the answer" campaign history
- Carbon capture promoted by fossil fuel industry as substitute for emissions cuts`,
  },
  {
    key: 'health',
    name: 'Health Misinformation',
    description: 'Anti-vaccine propaganda, quackery targeting vulnerable people, and attacks on evidence-based medicine',
    researchQuery: `Find websites, articles, and content that spread false health information, market dangerous alternative treatments, or undermine public health through misinformation.

Research these angles:
- VAERS data misrepresentation to fabricate vaccine death counts
- RFK Jr., Mercola, or similar anti-vax influencer content
- "Natural immunity is always superior" absolute arguments dismissing vaccine evidence
- "Cure cancer naturally" supplement and alternative therapy marketing
- "Doctors don't want you to know" health conspiracy content
- Ivermectin / hydroxychloroquine promoted as universal cures
- COVID vaccine conspiracy content (depopulation, microchip, mRNA gene editing)`,
  },
  {
    key: 'democracy',
    name: 'Democracy & Political Rights',
    description: 'Voter suppression advocacy, authoritarian admiration, and content undermining democratic participation',
    researchQuery: `Find articles and policy advocacy that restrict voting access, praise authoritarian governance, or normalize the erosion of democratic norms and institutions.

Research these angles:
- "Election integrity" voter suppression advocacy without evidence of fraud
- Strict voter ID defenses ignoring documented disenfranchisement
- Tucker Carlson / Orbán's Hungary admiration pieces
- "Strong executive power" arguments for reducing judicial or legislative checks
- "Courts are obstructing governance" executive overreach advocacy
- Dark money in politics defended as free speech
- Bothsidesism journalism treating factual asymmetries as balanced debates`,
  },
  {
    key: 'policing',
    name: 'Criminal Justice & Policing',
    description: 'Police brutality apologia, prison labor normalization, and opposition to accountability reforms',
    researchQuery: `Find articles and content that defend documented police misconduct, oppose accountability reforms, or normalize the exploitation of incarcerated people.

Research these angles:
- "Officer had no choice" defenses in clear excessive force cases
- Qualified immunity defense articles
- "Defund the police" strawman attacks conflating any reform with abolition
- "Prison labor teaches discipline" defenses of near-zero wage forced work
- Corporate PR around prison labor sourcing
- Arguments opposing body camera requirements or police transparency
- ALEC model legislation supporting prison labor expansion`,
  },
  {
    key: 'technology',
    name: 'Technology & Privacy',
    description: 'Surveillance normalization, social media harm denial, and AI ethics dismissal',
    researchQuery: `Find articles and industry-funded content that normalize mass surveillance, minimize documented harms from social media or AI systems, or argue tech companies should be free from accountability.

Research these angles:
- "Nothing to hide" surveillance defense articles
- Corporate surveillance capitalism defense ("data lets us serve you better")
- Facial recognition advocacy despite documented racial bias
- "Social media doesn't cause teen depression" industry-funded studies
- "Parents are responsible, not platforms" deflection from addictive design
- "AI safety is sci-fi hysteria" dismissal pieces
- "Don't regulate AI" arguments from effective accelerationism`,
  },
  {
    key: 'disability',
    name: 'Disability Rights',
    description: 'Opposition to disability accommodations, ADA enforcement, or content using disability as rhetorical weapon',
    researchQuery: `Find content that frames disability accommodations as excessive burden, opposes ADA enforcement, portrays disabled people as inherently less valuable, or weaponizes disability as political rhetoric.

Research these angles:
- "ADA lawsuits are shakedowns" business opposition to accessibility
- "Accommodations make everyone weak" arguments applied to disability
- Articles opposing disability benefits as enabling dependency
- Opposing neurodiversity accommodations in schools
- Using "mentally ill" as political insult
- "Participation trophies and ADA hurt society" framing`,
  },
  {
    key: 'war',
    name: 'War & Militarism',
    description: 'Warmongering, war crime denial, civilian harm minimization, and arms industry propaganda',
    researchQuery: `Find articles, op-eds, and think-tank content that advocate military intervention without acknowledging costs, minimize or deny documented war crimes, launder arms industry interests as security policy, or glorify militarism.

Research these angles:
- "Collateral damage" language normalizing civilian casualties
- War crime denial or apologia for documented atrocities (Fallujah, Yemen strikes, etc.)
- Arms industry funded think tanks advocating military escalation
- "Bombing them back to the stone age" hawkish commentary normalized in mainstream outlets
- Drone strike programs defended without acknowledging civilian death counts
- "Regime change is necessary" content ignoring historical failure record
- Veterans-as-props content from defense contractors`,
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
