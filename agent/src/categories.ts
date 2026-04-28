import type { Category } from './types.js';

export const CATEGORIES: Category[] = [
  // ── Economic Ideology & Exploitation ────────────────────────────────────────
  {
    key: 'union_busting',
    name: 'Union Busting & Anti-Labor',
    description: 'Content that frames union suppression as beneficial, "flexibility", or worker freedom',
    researchQuery: `Find opinion pieces, strategy articles, business advice, and news that advocate for union avoidance, portray unions as harmful to workers or the economy, or frame union-busting tactics as worker empowerment.

Research these angles:
- "union avoidance strategies" in business/HR publications
- Opinion pieces arguing unions hurt workers or raise prices
- Articles celebrating "right to work" laws
- Employer guides framed as protecting employees from unions
- Content arguing workers are better off without collective bargaining`,
  },
  {
    key: 'trickle_down',
    name: 'Trickle-Down Economics Propaganda',
    description: 'Supply-side cheerleading, tax cut mythology, billionaire job-creator narratives with no evidence',
    researchQuery: `Find articles, op-eds, and think-tank pieces that uncritically advocate for supply-side economics, argue tax cuts for the wealthy pay for themselves, or frame billionaires as the engine of economic growth without acknowledging wage stagnation or inequality evidence.

Research these angles:
- "tax cuts create jobs" op-eds from business publications
- "job creators" framing in economic commentary
- Heritage Foundation / Cato Institute pieces on trickle-down
- Articles dismissing wealth inequality studies
- "cutting capital gains taxes helps workers" arguments`,
  },
  {
    key: 'billionaire_worship',
    name: 'Billionaire Hagiography',
    description: 'Uncritical celebration of ultra-wealthy as deserving, heroic, or uniquely valuable',
    researchQuery: `Find articles and profiles that treat billionaires as inherently deserving of their wealth, portray extreme wealth as purely earned through merit, or frame billionaires as necessary and uniquely beneficial to society — without engaging with labor exploitation, tax avoidance, or systemic advantages.

Research these angles:
- Hagiographic profiles of Musk, Bezos, Thiel celebrating "genius" with no critique
- "Billionaires earned their wealth" argument pieces
- "Wealth taxes would hurt innovation" content
- Articles defending stock buybacks over worker wages
- "Entrepreneurs create wealth, not exploit it" framings`,
  },
  {
    key: 'gig_exploitation',
    name: 'Gig Economy Exploitation Disguised as Freedom',
    description: 'Framing misclassification of gig workers as empowerment or flexibility while ignoring lack of benefits',
    researchQuery: `Find articles and corporate PR that frame gig work misclassification (no benefits, no protections) as "freedom" and "flexibility" — while downplaying or ignoring the lack of healthcare, retirement, overtime protections, and the transfer of business risk onto workers.

Research these angles:
- Uber/Lyft/DoorDash PR about "flexible work"
- Chamber of Commerce arguments against AB5-style laws
- "Gig workers prefer independence" pieces funded by platforms
- Articles opposing gig worker minimum wage protections
- "Benefits would harm gig workers" arguments`,
  },
  {
    key: 'poverty_blaming',
    name: 'Poverty as Personal Failure / Bootstraps Mythology',
    description: 'Content that frames poverty as individual moral failing, ignoring systemic causes',
    researchQuery: `Find articles, op-eds, and policy pieces that attribute poverty primarily to personal choices, lack of discipline, or cultural failings — while dismissing systemic factors like wage stagnation, housing costs, healthcare costs, inherited wealth gaps, and structural racism.

Research these angles:
- "Bootstraps" framing in economic commentary
- "Poor people just need to make better choices" op-eds
- Arguments against welfare that moralize poverty
- "Culture of poverty" framing without systemic analysis
- Articles opposing minimum wage hikes by blaming worker habits`,
  },
  {
    key: 'child_labor',
    name: 'Child Labor Normalization',
    description: 'Arguments for loosening child labor laws or framing child labor as beneficial',
    researchQuery: `Find articles, think-tank pieces, and legislative commentary that argue for weakening child labor protections, frame child labor as "opportunity," or minimize documented harms of child labor — particularly in agriculture, meatpacking, or construction.

Research these angles:
- State legislation to loosen child labor laws and op-eds supporting it
- "Kids working teaches responsibility" framing applied to hazardous work
- Arguments that migrant child labor is a "pipeline" to adulthood
- Articles opposing federal child labor enforcement
- "Regulations cost youth their first jobs" framing`,
  },

  // ── Racism & Ethnic Hatred ───────────────────────────────────────────────────
  {
    key: 'race_science',
    name: 'Pseudoscientific Race Realism',
    description: 'Content using flawed or cherry-picked data to argue racial cognitive or behavioral hierarchies',
    researchQuery: `Find articles, blog posts, and pseudoscientific academic-adjacent content that uses statistical data, IQ studies, or genetics research — selectively or misleadingly — to argue for innate racial hierarchies in intelligence or behavior, while ignoring methodological critiques, environmental factors, and the history of this field's misuse.

Research these angles:
- "Race and IQ" articles on sites like American Renaissance or related
- "HBD" (human biodiversity) blog posts arguing racial cognitive differences
- Pieces citing discredited research like Murray/Herrnstein to argue policy
- "Why can't we talk about race and IQ" concern trolling pieces
- Articles framing critique of race science as "censorship"`,
  },
  {
    key: 'colorblind_racism',
    name: 'Colorblind Racism & DEI Backlash',
    description: 'Content using "colorblindness" to oppose anti-racist policies while ignoring structural racism',
    researchQuery: `Find articles and opinion pieces that invoke colorblindness to oppose affirmative action, DEI, or anti-racism initiatives — arguing racism is solved or that addressing race is itself racist — while ignoring evidence of ongoing structural discrimination in hiring, housing, lending, and policing.

Research these angles:
- "Colorblind" anti-DEI op-eds in mainstream publications
- "Reverse racism" arguments opposing affirmative action
- "MLK would oppose DEI" framing misappropriating civil rights history
- Articles framing anti-racism work as "divisive" or "Marxist"
- Pieces opposing racial equity policies in schools or companies`,
  },
  {
    key: 'great_replacement',
    name: 'Replacement Theory & Demographic Panic',
    description: 'Immigration panic framed as existential demographic threat to white population',
    researchQuery: `Find articles, opinion pieces, and online content that frame immigration as a deliberate attempt to "replace" or "dilute" the white population — whether using explicit replacement theory language or softer framing like "demographic change" as civilizational threat.

Research these angles:
- "Great replacement" or "replacement theory" content in semi-mainstream outlets
- Tucker Carlson-style "demographic change is a threat" op-eds
- Articles framing immigration as "population replacement" by elites
- "Western civilization" under demographic siege narratives
- Immigration restrictionist content with demographic panic framing`,
  },
  {
    key: 'confederate_apologia',
    name: 'Confederate Apologia & Lost Cause Revisionism',
    description: 'Content defending Confederate monuments, flags, or the "Lost Cause" mythology',
    researchQuery: `Find articles and opinion pieces defending Confederate monuments, the Confederate flag, or the "Lost Cause" narrative — arguing the Civil War wasn't primarily about slavery, framing Confederate statues as heritage rather than propaganda, or romanticizing the antebellum South.

Research these angles:
- "Heritage not hate" defenses of Confederate symbols
- Arguments that Confederate monuments are history not propaganda
- Lost Cause content arguing the Civil War was about states' rights not slavery
- Pushback against removal of Confederate statues framing removal as "erasing history"
- "The South was fighting for X, not slavery" revisionist arguments`,
  },

  // ── Misogyny & Gender Discrimination ────────────────────────────────────────
  {
    key: 'redpill_misogyny',
    name: 'Red Pill / Incel Ideology Disguised as Dating Advice',
    description: 'Misogynistic worldviews framed as self-help, dating strategy, or men\'s rights',
    researchQuery: `Find content that frames women as adversaries to manipulate, argues for male dominance in relationships as natural, dehumanizes women through "sexual market value" language, or promotes strategies to coerce or manipulate women — packaged as dating advice, men's self-improvement, or men's rights content.

Research these angles:
- "Red pill" dating advice sites and blogs
- "Hypergamy" content arguing women are biologically programmed to exploit men
- "Sigma male" / "alpha male" content with misogynistic premises
- Incel-adjacent content on mainstream platforms
- "Women belong in the home" dressed as traditionalist advice`,
  },
  {
    key: 'pay_gap_denial',
    name: 'Gender Pay Gap Denial',
    description: 'Content denying the gender pay gap through misleading comparisons or methodology manipulation',
    researchQuery: `Find articles and opinion pieces that deny the gender pay gap using the misleading "when you control for everything the gap disappears" argument — without acknowledging that the "everything" controlled for includes outcomes of discrimination (occupational segregation, negotiation norms, caregiving penalties), thereby laundering the discrimination itself.

Research these angles:
- "The gender pay gap myth" op-eds
- "When controlled for occupation there's no gap" articles
- Heritage Foundation / IWF pieces on pay gap being a myth
- "Women choose lower-paying jobs" arguments ignoring why
- Articles opposing equal pay legislation`,
  },

  // ── LGBTQ+ Discrimination ────────────────────────────────────────────────────
  {
    key: 'trans_panic',
    name: 'Trans Moral Panic & Anti-Trans Legislation Propaganda',
    description: 'Content manufacturing fear about trans people to justify discrimination',
    researchQuery: `Find articles, think-tank pieces, and news content that uses "groomer" rhetoric, "protect women's spaces" framing, or "protect children" framing to target trans people — without evidence of the claimed harms — or that promotes anti-trans legislation based on manufactured moral panic.

Research these angles:
- "Groomer" accusations targeting trans people and teachers
- "Bathroom bill" propaganda based on fabricated safety concerns
- "Detransition" stories weaponized against gender-affirming care
- "Protect women's sports" arguments against trans athletes using bad science
- Anti-trans legislative advocacy from Alliance Defending Freedom, Heritage, CPRC`,
  },
  {
    key: 'conversion_therapy',
    name: 'Conversion Therapy Defense & Promotion',
    description: 'Content defending or promoting conversion therapy for LGBTQ+ people',
    researchQuery: `Find articles, religious organization content, and advocacy pieces that defend conversion therapy as legitimate, frame banning it as religious freedom violation, or promote "change is possible" messaging for sexual orientation — in contradiction of all major medical and psychological organizations.

Research these angles:
- Religious organizations defending "sexual orientation change efforts"
- "Ex-gay" testimonials and the organizations that promote them
- Legal arguments against conversion therapy bans as religious freedom
- "Counselors should be able to help clients change" framing
- "Therapy bans restrict free speech" arguments`,
  },

  // ── Environmental Harm ───────────────────────────────────────────────────────
  {
    key: 'climate_denial',
    name: 'Climate Change Denial & Delay Propaganda',
    description: 'Content denying climate science or manufacturing delay to climate action',
    researchQuery: `Find articles, think-tank content, and op-eds that deny climate change, minimize its severity, attack climate scientists, or manufacture delay by arguing action is premature, too costly, or technologically impossible — often funded by or reflecting fossil fuel industry interests.

Research these angles:
- Heartland Institute, CEI, or similar fossil-fuel-funded climate denial
- "Climate scientists are wrong" op-eds citing fringe contrarians
- "The models are always wrong" delay arguments
- "Climate change is natural not man-made" content
- "Net zero will destroy the economy" catastrophizing without context`,
  },
  {
    key: 'greenwashing',
    name: 'Corporate Greenwashing',
    description: 'PR campaigns disguising polluters as environmental champions',
    researchQuery: `Find corporate PR content, sponsored journalism, and industry advocacy that falsely portrays fossil fuel companies, chemical companies, or heavy polluters as environmental leaders — using net-zero pledges without credible plans, "clean" branding for demonstrably dirty products, or environmental messaging from companies actively lobbying against environmental regulation.

Research these angles:
- ExxonMobil/Shell/BP "clean energy" advertising campaigns
- "Natural gas is clean" industry messaging
- "Carbon capture will solve everything" as delay tactic from fossil fuel industry
- Plastic industry "recycling is the answer" campaign history
- "Sustainable aviation fuel" greenwashing from airlines`,
  },

  // ── Health Misinformation ────────────────────────────────────────────────────
  {
    key: 'vaccine_disinfo',
    name: 'Vaccine Misinformation',
    description: 'Anti-vaccine content using fabricated data, emotional manipulation, or conspiracy framing',
    researchQuery: `Find articles, websites, and social media content that spreads false information about vaccine safety or efficacy — using fabricated studies, misrepresented data, celebrity testimonials over evidence, or conspiracy framing about pharmaceutical companies suppressing harm data.

Research these angles:
- VAERS data misrepresentation to claim vaccine deaths
- "Natural immunity is superior" absolute arguments dismissing vaccine data
- RFK Jr., Mercola, or similar anti-vax influencer content
- "Vaccines cause autism" content still circulating
- COVID vaccine "depopulation" and "microchip" conspiracy content`,
  },
  {
    key: 'alt_medicine_scams',
    name: 'Predatory Alternative Medicine',
    description: 'Dangerous quackery marketed to vulnerable people as cancer cures or disease treatments',
    researchQuery: `Find websites and content that market scientifically unsupported alternative treatments to vulnerable people — particularly cancer patients, autoimmune patients, or parents of sick children — with false efficacy claims, cherry-picked testimonials, and attacks on evidence-based medicine.

Research these angles:
- "Cure cancer naturally" supplement or alternative therapy sites
- "Doctors don't want you to know" health misinformation
- Ivermectin / hydroxychloroquine "cures everything" content
- "Detox" and "cleanse" products with false health claims
- Anti-chemotherapy content steering patients away from treatment`,
  },

  // ── Authoritarian & Anti-Democratic ─────────────────────────────────────────
  {
    key: 'voter_suppression',
    name: 'Voter Suppression Justification',
    description: 'Content framing voter suppression measures as "election integrity" without evidence of fraud',
    researchQuery: `Find articles, op-eds, and policy advocacy that support voter ID laws, voter roll purges, polling place closures, or other restrictions on voting access — framed as "election integrity" measures despite no evidence of significant voter fraud and documented disproportionate impact on minority voters.

Research these angles:
- Heritage Foundation "election integrity" advocacy
- Op-eds supporting strict voter ID without addressing disenfranchisement
- Arguments defending voter roll purging and its disparate impact
- "Voting should require more effort" meritocratic framing
- Content dismissing documented voter suppression as liberal paranoia`,
  },
  {
    key: 'autocrat_admiration',
    name: 'Autocrat Admiration & Strongman Apologia',
    description: 'Content praising authoritarians, normalizing strongman rule, or calling for reduced democratic checks',
    researchQuery: `Find articles and commentary that uncritically admire Putin, Orbán, Xi, or similar autocrat or strongman leaders as effective or admirable — or that argue Western democracies need stronger executive power, reduced judicial oversight, or "temporary" suspension of democratic norms for efficiency.

Research these angles:
- Tucker Carlson / Ben Shapiro / Charlie Kirk content praising Orbán's Hungary
- "Putin makes sense" op-eds in US conservative media
- "Strong leadership is what the West needs" anti-democratic advocacy
- "The courts are obstructing governance" arguments for executive overreach
- Articles framing democracy as inefficient compared to authoritarian governance`,
  },

  // ── Surveillance & Privacy ───────────────────────────────────────────────────
  {
    key: 'surveillance_normalization',
    name: 'Mass Surveillance Normalization',
    description: '"Nothing to hide" arguments and corporate/government surveillance apologia',
    researchQuery: `Find articles and op-eds that normalize or advocate for mass surveillance — using "nothing to hide" reasoning, arguing surveillance improves safety without acknowledging chilling effects, or defending corporate data harvesting as a fair exchange for free services without engaging with consent, power, or abuse issues.

Research these angles:
- "If you have nothing to hide" surveillance defense articles
- Corporate surveillance capitalism defense ("we need data to serve you better")
- Facial recognition advocacy in law enforcement despite accuracy bias evidence
- "Smart city" surveillance normalized as progress
- Arguments opposing encryption as "helping criminals"`,
  },

  // ── Criminal Justice Bias ────────────────────────────────────────────────────
  {
    key: 'police_apologia',
    name: 'Police Brutality Apologia & Reform Opposition',
    description: 'Content defending documented police brutality or opposing accountability reforms',
    researchQuery: `Find articles and op-eds that minimize documented police brutality, defend individual officers in cases of clear misconduct, oppose police accountability measures using "bad apples" or "few bad actors" framing, or frame any criticism of policing as an attack on public safety.

Research these angles:
- "Officer had no choice" defenses in clear excessive force cases
- "Defund the police" strawman attacks conflating reform with abolition
- Qualified immunity defense articles
- "Police are the most persecuted group" victimhood narratives
- Articles opposing body camera requirements or transparency laws`,
  },
  {
    key: 'prison_labor',
    name: 'Prison Labor Normalization',
    description: 'Content defending or normalizing the exploitation of incarcerated workers',
    researchQuery: `Find articles and content that defend prison labor programs paying near-zero wages, frame forced prison labor as "rehabilitation," or oppose efforts to pay incarcerated workers minimum wage — including corporate sourcing from prison labor presented neutrally or positively.

Research these angles:
- "Prison labor teaches skills and discipline" arguments
- Corporate defense of prison labor sourcing
- Arguments against prison labor wage reform
- "Prison work programs reduce recidivism" without examining wage exploitation
- ALEC model legislation supporting prison labor expansion`,
  },

  // ── Propaganda & Media Manipulation ─────────────────────────────────────────
  {
    key: 'false_equivalence',
    name: 'False Equivalence & Bothsidesism',
    description: 'Mainstream media treating factual asymmetries as balanced debates',
    researchQuery: `Find journalism and commentary that creates false equivalence between parties or positions with dramatically different factual groundings — treating fringe climate denial as equivalent to scientific consensus, equating minor Democratic and major Republican norm violations, or presenting "both sides" on settled empirical questions.

Research these angles:
- News articles treating climate consensus and denial as equivalent
- "Both sides do it" journalism on documented one-sided norm violations
- "To be fair to both sides" framing on factual questions
- Horse-race journalism that avoids taking positions on verifiable facts
- Bothsidesism that launders extremism as normal political disagreement`,
  },
  {
    key: 'think_tank_astroturfing',
    name: 'Fossil Fuel / Corporate Funded Think Tank Astroturfing',
    description: 'Corporate-funded opinions presented as independent expert analysis',
    researchQuery: `Find think-tank reports, op-eds, and policy papers from organizations funded by fossil fuel, pharmaceutical, tobacco, or other industries — presented as independent expert analysis without disclosure of conflicts of interest, used to argue against regulation that would harm funders.

Research these angles:
- Heritage Foundation / AEI / Manhattan Institute oil-funded policy pieces
- "Independent experts say regulation would cost jobs" content from industry-funded groups
- ALEC model legislation presented as grassroots policy reform
- Heartland Institute climate denial with undisclosed Exxon funding history
- Tobacco playbook methodology applied to other industries`,
  },

  // ── Tech Harms ───────────────────────────────────────────────────────────────
  {
    key: 'social_media_addiction_defense',
    name: 'Social Media Addiction Defense',
    description: 'Content minimizing documented social media harms on youth mental health',
    researchQuery: `Find articles and industry-funded research that minimize or deny the documented links between social media use and depression, anxiety, and self-harm in adolescents — or that argue platforms have no responsibility for addictive design patterns.

Research these angles:
- "Social media doesn't cause teen depression" industry-funded studies
- "Parents are responsible, not platforms" deflection content
- "Screen time panic is moral panic" dismissals ignoring internal platform research
- Mark Zuckerberg / Meta PR on teen mental health
- Arguments opposing social media age restrictions`,
  },
  {
    key: 'ai_ethics_dismissal',
    name: 'AI Safety / Ethics Dismissal',
    description: 'Content minimizing AI harms or dismissing AI ethics as anti-progress',
    researchQuery: `Find articles that dismiss AI safety concerns as sci-fi hysteria, frame AI ethics work as obstructing progress, minimize documented harms from biased AI systems in hiring or criminal justice, or argue AI companies should be free from regulation.

Research these angles:
- "AI safety concerns are overblown/sci-fi" dismissal pieces
- "AI ethics is slowing down innovation" tech-bro op-eds
- Articles minimizing algorithmic bias in facial recognition or hiring
- Effective accelerationism (e/acc) content dismissing AI harms
- "Don't regulate AI, it will regulate itself" arguments`,
  },

  // ── Colonialism & Imperialism ────────────────────────────────────────────────
  {
    key: 'colonialism_revisionism',
    name: 'Colonialism / Imperialism Revisionism',
    description: 'Content rehabilitating colonialism as net-positive or denying its ongoing harms',
    researchQuery: `Find articles, op-eds, and academic adjacent content that frame colonialism as a net positive for colonized peoples, minimize documented atrocities, argue colonialism "built infrastructure," or suggest former colonies should be grateful — while dismissing economic extraction, cultural destruction, and lasting inequality.

Research these angles:
- "British Empire was good actually" Niall Ferguson-style revisionism
- "Colonialism built Africa's roads" arguments
- "Civilizing mission was genuine" historical apologia
- Articles opposing reparations for colonial harms
- "Why focus on colonial past instead of moving forward" deflection`,
  },
  {
    key: 'indigenous_rights_denial',
    name: 'Indigenous Rights Denial',
    description: 'Content opposing indigenous rights, land rights, or tribal sovereignty',
    researchQuery: `Find articles and policy advocacy that oppose indigenous land rights, tribal sovereignty, sacred site protections, or treaty rights — using "all Americans are equal" colorblind framing, resource extraction arguments, or dismissal of indigenous cultural and spiritual claims.

Research these angles:
- Pipeline project advocacy dismissing treaty violations (Dakota Access, etc.)
- "Indians don't deserve special rights" equal protection framing
- Arguments opposing tribal sovereignty and gaming rights
- "Sacred site" skepticism in environmental impact discussions
- Content opposing land acknowledgments as meaningless virtue signaling`,
  },

  // ── Religious Extremism ──────────────────────────────────────────────────────
  {
    key: 'christian_nationalism',
    name: 'Christian Nationalism & Dominionism',
    description: 'Content advocating America as a Christian nation with Christian law as policy basis',
    researchQuery: `Find articles, sermons, and policy advocacy that frame the US as founded as a Christian nation and argue Christian values should be encoded in law — including pushing for Christian prayer in schools, opposing LGBTQ+ rights on explicitly Christian grounds, or arguing the Constitution is a Christian document.

Research these angles:
- "America is a Christian nation" legal and policy advocacy
- Project Blitz / Freedom from Religion Foundation opposition content
- Seven Mountain Dominionism explicit content
- "Religious freedom" framing to impose Christian practices in public spaces
- "Secularism is an attack on Christianity" persecution complex content`,
  },

  // ── Ableism ──────────────────────────────────────────────────────────────────
  {
    key: 'ableism',
    name: 'Ableism & Disability Rights Opposition',
    description: 'Content opposing disability accommodations, accessibility laws, or using disability as insult',
    researchQuery: `Find content that frames disability accommodations as excessive burden, opposes ADA enforcement, portrays disabled people as inherently less productive or valuable, or uses disability as a rhetorical weapon (e.g., calling opponents "mentally ill" as insult, mocking physical disability).

Research these angles:
- "ADA lawsuits are shakedowns" business opposition to accessibility requirements
- "Accommodation requirements hurt small businesses" framings
- "Participation trophies / accommodations make everyone weak" arguments applied to disability
- Articles opposing disability benefits as enabling dependency
- Content opposing neurodiversity accommodations in schools`,
  },

  // ── Meritocracy Myth ─────────────────────────────────────────────────────────
  {
    key: 'meritocracy_myth',
    name: 'Meritocracy Mythology & Systemic Racism Denial',
    description: 'Arguments that success is purely merit-based, ignoring structural advantages and racism',
    researchQuery: `Find op-eds, business commentary, and think-tank pieces that insist the US is a pure meritocracy where anyone can succeed through hard work — while ignoring inheritance, legacy admissions, social capital, racial wealth gaps, redlining effects, and documented hiring discrimination.

Research these angles:
- "America is a meritocracy, stop making excuses" op-eds
- "Systemic racism doesn't exist anymore" arguments
- "Hard work is all it takes" success stories weaponized against systemic analysis
- Articles opposing affirmative action citing "pure merit" arguments
- "The racial wealth gap is explained by culture not discrimination" pieces`,
  },

  // ── Dark Money & Regulatory Capture ─────────────────────────────────────────
  {
    key: 'dark_money_normalization',
    name: 'Dark Money & Regulatory Capture Normalization',
    description: 'Content defending unlimited dark money in politics as free speech without acknowledging corruption',
    researchQuery: `Find articles and op-eds that defend Citizens United and unlimited dark money in politics as purely free speech — without engaging with documented corruption, regulatory capture, or the drowning out of ordinary voters' interests by billionaire donors.

Research these angles:
- Citizens United defense articles framing campaign finance as free speech
- "Dark money is just speech" libertarian arguments
- Koch Network / Federalist Society funding defense pieces
- "Campaign finance reform is censorship" framing
- Articles opposing disclosure requirements for political donors`,
  },

  // ── Islamophobia & Xenophobia ─────────────────────────────────────────────────
  {
    key: 'islamophobia',
    name: 'Islamophobia & Muslim Collective Punishment',
    description: 'Content treating Muslims as a monolithic threat or holding all Muslims responsible for extremist acts',
    researchQuery: `Find articles and opinion content that frame all Muslims or Islam itself as inherently violent, hold Muslim communities collectively responsible for terrorist attacks, advocate for Muslim surveillance or travel bans using sweeping religious generalizations, or promote "Islam is incompatible with democracy" arguments.

Research these angles:
- "Islam is inherently violent" framing in mainstream outlets
- "Why don't moderate Muslims condemn terrorism" collective guilt arguments
- Robert Spencer / Pamela Geller / Jihad Watch-style content
- Muslim travel ban defense articles
- "Sharia law is coming to America" moral panic content`,
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
