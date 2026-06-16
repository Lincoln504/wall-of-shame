import type { Category } from './types.js';

export const CATEGORIES: Category[] = [
  {
    key: 'labor',
    name: 'Labor & Workers\' Rights',
    description: 'Efforts to weaken worker protections, present exploitation as freedom, and undermine the ability of workers to act collectively.',
    researchQuery: `Focus: The systematic dismantling of labor protections and the presentation of unfair management practices as normal or beneficial.
    
    Strategies to explore:
    - CONTRACTUAL SHIFTING: Presenting employees as "independent" to remove benefits and basic rights.
    - UNDERMINING UNIONS: Arguing that individual bargaining is better than collective power and presenting anti-union efforts as "protecting" worker choice.
    - WAGE REDUCTION: Arguments for lower minimum standards or creating groups of workers with fewer rights.
    - CHILD LABOR JUSTIFICATION: Presenting youth work as a "character building" opportunity to justify removing age and hour protections.
    - BLAMING THE POOR: Language that treats economic hardship as a personal failure or "dependency" rather than a systemic issue.
    - SAFETY AS BURDEN: Framing workplace safety rules as unnecessary "red tape" that hurts the economy.
    - GENERAL NARRATIVE: Broadly presenting worker rights as an obstacle to progress or individual freedom.
    - AND OTHER strategies: These are just starting points; find the underlying mechanisms of framing and intentionality.`,
  },
  {
    key: 'economics',
    name: 'Economic Inequality & Propaganda',
    description: 'Justifying extreme wealth gaps, promoting policies that benefit the top at the expense of the bottom, and presenting corporate interests as the public interest.',
    researchQuery: `Focus: Arguments used to justify extreme inequality and the use of public resources for private gain.
    
    Strategies to explore:
    - TAX CUT JUSTIFICATION: Arguments that cutting taxes for the wealthy pays for itself or is the only way to get growth.
    - WEALTH CELEBRATION: Presenting extreme wealth as purely "earned" by merit and treating taxes on wealth as unfair.
    - SUBSIDY ADVOCACY: Defending government help for profitable companies while opposing help for ordinary people.
    - MONOPOLY DEFENSE: Presenting market domination as "efficiency" and treating rules against it as government overreach.
    - ONE-SIDED DEREGULATION: Highlighting the costs of rules for businesses while ignoring the benefits to the public.
    - INVESTOR OVER WORKERS: Prioritizing payments to shareholders over investments in workers and defending massive executive pay gaps.
    - IDEOLOGICAL SHIELDS: New ways of framing the economy that protect concentrated wealth from being challenged.
    - AND OTHER strategies: These are just starting points; find the underlying mechanisms of framing and intentionality.`,
  },
  {
    key: 'race',
    name: 'Racial Discrimination & Revisionism',
    description: 'Reviving racial hierarchies, denying the reality of systemic inequality, and sanitizing the history of racial violence.',
    researchQuery: `Focus: The denial of systemic racism and the attempt to make historical or current racial oppression seem acceptable or non-existent.
    
    Strategies to explore:
    - EQUITY ATTACKS: Framing fairness-focused policies as "reverse discrimination" and using "colorblind" language to hide the reality of race-based outcomes.
    - HISTORY CLEANUP: Presenting colonialism as a "net positive," minimizing the horror of slavery or genocide, and ignoring the roots of current inequality.
    - NATURALIZING GAPS: Using biased science or "culture" to explain why some groups have less, without mentioning the role of policy or history.
    - ATTACKING PROTESTERS: Presenting civil rights movements as "divisive" or "dangerous" to justify shutting them down.
    - XENOPHOBIC OVERLAP: Where arguments about "racial purity" meet fear-mongering about demographic change.
    - TEACHING REVISIONISM: Systematic efforts to change what is taught in schools to hide the history of racial injustice.
    - AND OTHER strategies: These are just starting points; find the underlying mechanisms of framing and intentionality.`,
  },
  {
    key: 'gender',
    name: 'Misogyny & Patriarchal Backlash',
    description: 'Justifying the subordination of women, normalizing misogyny, attacking feminism, and rolling back women\'s rights and bodily autonomy.',
    researchQuery: `Focus: Content that normalizes misogyny and patriarchal power, frames the subordination of women as natural or desirable, and attacks feminism and women's rights. (Scope is sex/women-based: patriarchy, misogyny, women's autonomy — NOT gender-identity or sexual-orientation topics.)

    Strategies to explore:
    - NATURALIZING SUBORDINATION: Presenting traditional power gaps between men and women as "natural," biological, or God-ordained; "tradwife"/anti-career framing used to push women out of public life.
    - MANOSPHERE & REDPILL MISOGYNY: Dating/advice/"high-value man" content and male-grievance media that dress up contempt for women as self-help or common sense.
    - CHOICE AS DEFLECTION: Claiming the gender pay gap or underrepresentation is purely women's individual "choices" to avoid confronting systemic barriers and discrimination.
    - BODILY AUTONOMY ATTACKS: Dehumanizing language against reproductive healthcare and women's right to make their own medical decisions; framing forced birth as "protection."
    - ANTI-FEMINIST GRIEVANCE: Presenting feminism itself as the problem, mocking women's advancement, or recasting men as the real victims of equality.
    - VIOLENCE MINIMIZATION: Downplaying, excusing, or victim-blaming domestic and sexual violence against women.
    - AND OTHER strategies: These are just starting points; find the underlying mechanisms of framing and intentionality.`,
  },
  {
    key: 'immigration',
    name: 'Immigration & Xenophobia',
    description: 'Dehumanizing immigrants, using demographic fear as a political tool, and framing migration as a threat.',
    researchQuery: `Focus: The manufactured presentation of migration as a threat to national survival and the attack on immigrant rights.
    
    Strategies to explore:
    - DEMOGRAPHIC ALARM: Framing migration as an "invasion" or a "replacement" of the current population.
    - CRIMINALITY NARRATIVE: Using specific anecdotes to make it seem like immigrants are inherently dangerous.
    - JOB COMPETITION MYTHS: Framing immigrants as the main cause of low wages and a "drain" on public money.
    - REMOVING PROTECTIONS: Arguing for the removal of legal rights and the normalization of mass detention.
    - NATIVIST IDENTITY: Defining the nation in a way that excludes certain groups and presents integration as a failure.
    - BUREAUCRATIC HARASSMENT: Using procedural changes to make it impossible for immigrants to maintain legal status.
    - AND OTHER strategies: These are just starting points; find the underlying mechanisms of framing and intentionality.`,
  },
  {
    key: 'religion',
    name: 'Religious Nationalism & Sectarian Discrimination',
    description: 'Using religious doctrine to shape public law and the systematic removal of secular protections.',
    researchQuery: `Focus: Attempts to give specific religious views a privileged place in government and public life.
    
    Strategies to explore:
    - RELIGIOUS REVISIONISM: Presenting the nation as "fundamentally religious" to justify using doctrine as law.
    - WEAPONIZING EXEMPTIONS: Using "religious freedom" as an excuse to ignore civil rights, labor, or health laws.
    - DOCTRINE AS LAW: Using scripture to justify taking away rights from others (like reproductive or LGBTQ+ rights).
    - CLASSROOM CAPTURE: Pushing specific religious teachings into public schools and using public money for religious purposes.
    - MARGINALIZING MINORITIES: Presenting a diverse society as a form of "persecution" against the majority religion.
    - ERODING SEPARATION: Efforts to break down the wall between religious power and government authority.
    - AND OTHER strategies: These are just starting points; find the underlying mechanisms of framing and intentionality.`,
  },
  {
    key: 'climate',
    name: 'Climate & Environmental Harm',
    description: 'Delaying environmental action through misleading framing and downplaying ecological damage.',
    researchQuery: `Focus: The strategic effort to slow down climate action using denial, greenwashing, or economic fear-mongering.
    
    Strategies to explore:
    - MISLEADING GREEN CLAIMS: Using terms like "net zero" or "bridge fuel" to hide the continued expansion of oil and gas.
    - ECONOMIC FEAR: Presenting climate action as "too expensive" or "ruinous" to justify doing nothing.
    - DOUBT MANUFACTURING: Attacking climate science and giving a platform to contrarian "experts" to create the illusion of a debate.
    - SUBSIDY PROTECTION: Defending help for the fossil fuel industry while attacking help for renewable energy.
    - OFFSET DISTRACTION: Using unverified carbon offsets as a way to avoid actually reducing pollution.
    - INEVITABILITY ARGUMENTS: Claiming that environmental collapse is unavoidable to justify continuing to pollute.
    - AND OTHER strategies: These are just starting points; find the underlying mechanisms of framing and intentionality.`,
  },
  {
    key: 'health',
    name: 'Health Misinformation',
    description: 'Undermining public health, promoting unproven treatments, and attacking evidence-based medicine.',
    researchQuery: `Focus: The effort to damage trust in health authorities and promote dangerous or unverified medical claims.
    
    Strategies to explore:
    - DATA MISINTERPRETATION: Taking health databases out of context to create scary narratives about vaccines or treatments.
    - CONSPIRACY FRAMING: Presenting standard medicine as a corporate plot to push people toward unproven "alternatives."
    - WELLNESS PROFITEERING: Selling "cures" or "detoxes" to sick people without any evidence that they work.
    - ATTACKING PUBLIC SAFETY: Framing health rules (like masking or clean air) as "tyranny" to undermine safety measures.
    - SKEWNING RISK: Exaggerating the risks of medicine while pretending the risks of the disease don't exist.
    - FREEDOM AS DEFLECTION: Using "medical freedom" as a way to ignore the need for collective public health safety.
    - AND OTHER strategies: These are just starting points; find the underlying mechanisms of framing and intentionality.`,
  },
  {
    key: 'democracy',
    name: 'Democracy & Political Rights',
    description: 'Normalizing the loss of democratic rights, making it harder to vote, and justifying authoritarian power.',
    researchQuery: `Focus: The slow removal of democratic power and the attempt to make non-democratic rule seem acceptable.
    
    Strategies to explore:
    - DISENFRANCHISEMENT: Using "voter integrity" as a reason to pass laws that make it harder for people to vote.
    - AUTHORITARIAN PRAISE: Talking up "strongman" leaders and presenting democratic discussion as a sign of weakness.
    - HIDDEN INFLUENCE: Defending the right to spend unlimited, anonymous money in politics as "free speech."
    - BYPASSING THE PEOPLE: Using the courts to pass unpopular policies that couldn't get through the normal law-making process.
    - REJECTING RESULTS: Normalizing the refusal to accept election losses and using government power against political rivals.
    - ATTACKING INSTITUTIONS: Broad efforts to destroy trust in the foundations of democratic government.
    - AND OTHER strategies: These are just starting points; find the underlying mechanisms of framing and intentionality.`,
  },
  {
    key: 'policing',
    name: 'Criminal Justice & Policing',
    description: 'Justifying state violence, normalizing prison exploitation, and attacking efforts to hold the system accountable.',
    researchQuery: `Focus: The defense of excessive state power and the normalization of exploitative carceral systems.
    
    Strategies to explore:
    - VIOLENCE JUSTIFICATION: Using "split-second" excuses to make the use of excessive force by the state seem normal.
    - AVOIDING ACCOUNTABILITY: Defending laws that let state actors avoid being held responsible for their actions.
    - CARCERAL PROFIT: Normalizing the use of prisoners for near-free labor and justifying companies making money from jails.
    - ATTACKING REFORM: Claiming that trying to fix the system is the main cause of crime and social problems.
    - HARSHER SENTENCING: Pushing for mass incarceration and using "law and order" language to target specific communities.
    - EXPANDING CONTROL: Arguing for more surveillance and police power through new technology and laws.
    - AND OTHER strategies: These are just starting points; find the underlying mechanisms of framing and intentionality.`,
  },
  {
    key: 'technology',
    name: 'Technology & Privacy',
    description: 'Normalizing digital spying, ignoring the harms of technology, and dismissing ethical concerns about AI.',
    researchQuery: `Focus: The effort to make mass surveillance seem normal and to ignore the damage tech can do to society.
    
    Strategies to explore:
    - SURVEILLANCE EXCUSES: Using "nothing to hide" arguments to justify mass data collection and biometrics.
    - BIAS AS EFFICIENCY: Pretending that biased computer systems are just "innovative" or "objective."
    - DOWNPLAYING HARM: Minimizing how social media impacts mental health or democracy, often with industry money.
    - ETHICS DISMISSAL: Calling safety and ethical concerns "anti-progress" or "hysterical."
    - REMOVING PRIVACY: Fighting against laws that protect data in favor of letting companies "police themselves."
    - TECH AS DESTINY: Claiming that harmful tech trends are "unavoidable" so people stop trying to regulate them.
    - AND OTHER strategies: These are just starting points; find the underlying mechanisms of framing and intentionality.`,
  },
  {
    key: 'disability',
    name: 'Disability Rights',
    description: 'Marginalizing disabled people, presenting accessibility as a burden, and fighting against the enforcement of rights.',
    researchQuery: `Focus: Presenting the needs of disabled people as an unfair economic or personal burden on others.
    
    Strategies to explore:
    - DISCREDITING RIGHTS: Presenting accessibility lawsuits as "shakedowns" and complaining that basic fairness is "too expensive."
    - BLAMING THE INDIVIDUAL: Framing support as "enabling" and pretending that disability fraud is a massive problem.
    - ABLEIST LANGUAGE: Using disability as a way to insult others and treating different ways of thinking as personal failures.
    - JUSTIFYING EXCLUSION: Defending the refusal to provide accommodations in schools or jobs under the guise of "merit."
    - FOCUS ON CONTROL: Prioritizing institutionalization over letting people live in their own communities with their rights intact.
    - PERSONALIZING FAILURE: Treating disability as an individual problem to be "fixed" rather than a civil rights issue.
    - AND OTHER strategies: These are just starting points; find the underlying mechanisms of framing and intentionality.`,
  },
  {
    key: 'war',
    name: 'War & Militarism',
    description: 'Normalizing military violence, hiding the influence of the arms industry, and downplaying the human cost of war.',
    researchQuery: `Focus: The effort to make military violence seem normal and the capture of government policy by the arms industry.
    
    Strategies to explore:
    - PUSHING FOR WAR: Advocating for more fighting and "regime change" while hiding the role of the companies that profit from it.
    - CLEANING UP HARM: Using technical language (like "precision strike") to hide the reality of civilian deaths.
    - HIDING ATROCITIES: Dismissing reports of war crimes as "fake" or unavoidable results of war.
    - WAR AS JOBS: Presenting the sale of weapons as a "jobs program" or a way to keep the world "stable."
    - DOMESTIC MILITARISM: Bringing military gear and tactics into local policing and government.
    - INEVITABLE CONFLICT: Framing global fights as "unavoidable" to justify spending forever on the military.
    - AND OTHER strategies: These are just starting points; find the underlying mechanisms of framing and intentionality.`,
  },
  {
    key: 'spectacle',
    name: 'Sports, Spectacle & Sportswashing',
    description: 'Coverage tied to whatever major sporting or entertainment spectacle is in the news now that launders the image of repressive regimes, normalizes nationalism and militarism, or hides the exploitation behind the show.',
    researchQuery: `Focus: Opinion, PR, and "alternative" coverage tied to whatever major sporting or entertainment spectacle is happening RIGHT NOW that works to normalize, justify, or hide harm. First find what big events are currently in the news, then target the harm-normalizing framing around them — do NOT limit yourself to any single event or assume a specific one.

    Strategies to explore:
    - SPORTSWASHING: Coverage that helps an authoritarian or repressive host look modern, open, or benevolent by association with a marquee event, while ignoring its rights record.
    - NATIONALISM & JINGOISM: Treating flag-waving "national pride" and us-vs-them framing around competition as pure and beyond criticism, sliding into xenophobia or militarism.
    - HIDDEN WORKER EXPLOITATION: Celebrating stadiums, venues, and spectacles while ignoring or excusing the migrant/gig/temporary workers who built and ran them — their wages, safety, or deaths.
    - DISPLACEMENT & PUBLIC COST: Framing mega-event spending, evictions, surveillance, and "cleanup" of the poor as worth it for prestige or growth.
    - CELEBRITY DISTRACTION: Using spectacle and star power to launder a sponsor, regime, or policy, or to crowd out coverage of harm.
    - MANUFACTURED UNITY: Presenting an event as proof that "we are all together now," erasing real conflicts and inequalities.
    - AND OTHER strategies: These are just starting points; find whatever current spectacle is being used to normalize harm, and the mechanism of the framing.`,
  },
  {
    key: 'current_affairs',
    name: 'Current Affairs & the News Cycle',
    description: 'Op-eds and hot-takes reacting to whatever is dominating the news right now — recent rulings, legislation, elections, disasters, or economic shocks — that frame a regressive response as common sense or inevitable.',
    researchQuery: `Focus: Find the major news stories breaking RIGHT NOW and target the opinion/advocacy coverage that uses them to normalize, justify, or hide the harm of regressive policy. First identify what is currently in the headlines, then find the framing — do NOT hardcode or assume a specific topic.

    Strategies to explore:
    - CRISIS OPPORTUNISM: Using a fresh disaster, attack, or economic scare to push cuts, crackdowns, deregulation, or rollbacks as the "only responsible" response.
    - MANUFACTURED INEVITABILITY: Framing a regressive reaction to a current event as common sense, unavoidable, or what "everyone now agrees" on.
    - SELECTIVE OUTRAGE: Amplifying a trending grievance to justify punishing a vulnerable group, while ignoring the powerful actors involved.
    - RULING & LEGISLATION SPIN: Celebrating a recent court ruling, law, or executive action that strips rights or protections as a victory for freedom or order.
    - FLOOD-THE-ZONE: Reactive hot-takes that bury context and dissent under a wave of framing tied to the day's headlines.
    - HORSE-RACE DISTRACTION: Treating a current political fight as pure spectacle or strategy to avoid examining who actually gets hurt by the outcome.
    - AND OTHER strategies: These are just starting points; find whatever is currently in the news being used to normalize harm, and the mechanism of the framing.`,
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
