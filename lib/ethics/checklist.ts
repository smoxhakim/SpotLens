/**
 * Ethical / Shariah **research** checklist data.
 *
 * This is research material, not a religious ruling. Nothing in this file
 * declares any asset permissible or impermissible, and the product must never
 * present it that way — see ETHICAL_CHECKLIST_DISCLAIMER, which is rendered
 * alongside every checklist.
 *
 * Answers describe the project and its token, and are deliberately conservative:
 *
 *  - YES / NO are used only where the fact is plain and specific to the project.
 *  - UNCLEAR is used wherever an honest answer depends on a distinction the
 *    reader has to make themselves — most often the difference between a
 *    neutral platform and the applications built on top of it.
 *
 * A general-purpose smart contract chain does not lend money, but it hosts
 * lending protocols. Calling that a clean "no" would hide the question the
 * reader came here to ask, so those answers are UNCLEAR with the distinction
 * spelled out.
 */

export type ChecklistAnswer = "YES" | "NO" | "UNCLEAR";

export interface EthicalChecklistSeed {
  symbol: string;
  whatProjectDoes: string;
  tokenUtility: string;
  involvesInterestLending: ChecklistAnswer;
  involvesInterestLendingNote: string;
  supportsGambling: ChecklistAnswer;
  supportsGamblingNote: string;
  supportsProhibitedIndustries: ChecklistAnswer;
  supportsProhibitedNote: string;
  hasClearUtility: ChecklistAnswer;
  hasClearUtilityNote: string;
}

/** Note shared by every programmable chain: the platform is neutral, its apps are not. */
const PLATFORM_NEUTRALITY =
  "The protocol itself does not provide this. It is general-purpose infrastructure, and third parties have deployed applications of this kind on it. Whether a neutral platform inherits the character of what runs on it is exactly the question to take to a qualified scholar.";

const STAKING_NOTE =
  "This is a proof-of-stake network, so holders can earn staking rewards. Views differ on how staking rewards should be treated; the token can be held without staking.";

/** A general-purpose programmable chain (L1 or L2). */
function platform(
  symbol: string,
  whatProjectDoes: string,
  tokenUtility: string,
  options: { proofOfStake?: boolean } = {},
): EthicalChecklistSeed {
  return {
    symbol,
    whatProjectDoes,
    tokenUtility,
    involvesInterestLending: "UNCLEAR",
    involvesInterestLendingNote: PLATFORM_NEUTRALITY,
    supportsGambling: "UNCLEAR",
    supportsGamblingNote: PLATFORM_NEUTRALITY,
    supportsProhibitedIndustries: "UNCLEAR",
    supportsProhibitedNote: PLATFORM_NEUTRALITY,
    hasClearUtility: "YES",
    hasClearUtilityNote: `${tokenUtility}${options.proofOfStake ? ` ${STAKING_NOTE}` : ""}`,
  };
}

/** A single-purpose network that does not run third-party applications. */
function singlePurpose(
  symbol: string,
  whatProjectDoes: string,
  tokenUtility: string,
  utilityNote?: string,
): EthicalChecklistSeed {
  const none =
    "The network does one thing and does not host third-party applications, so this does not arise at the protocol level.";
  return {
    symbol,
    whatProjectDoes,
    tokenUtility,
    involvesInterestLending: "NO",
    involvesInterestLendingNote: none,
    supportsGambling: "NO",
    supportsGamblingNote: none,
    supportsProhibitedIndustries: "NO",
    supportsProhibitedNote:
      "The network is a settlement layer and does not select who transacts on it. It provides nothing specific to any industry.",
    hasClearUtility: "YES",
    hasClearUtilityNote: utilityNote ?? tokenUtility,
  };
}

/** Infrastructure with a specific, non-financial job. */
function infrastructure(
  symbol: string,
  whatProjectDoes: string,
  tokenUtility: string,
): EthicalChecklistSeed {
  const none =
    "This is not part of what the protocol does. Its function is technical infrastructure, and the token pays for that service.";
  return {
    symbol,
    whatProjectDoes,
    tokenUtility,
    involvesInterestLending: "NO",
    involvesInterestLendingNote: none,
    supportsGambling: "UNCLEAR",
    supportsGamblingNote:
      "The service is neutral and its customers are not vetted, so some may operate in areas the reader would want to exclude.",
    supportsProhibitedIndustries: "UNCLEAR",
    supportsProhibitedNote:
      "The service is sold to anyone who pays for it, so the protocol does not screen what its customers do.",
    hasClearUtility: "YES",
    hasClearUtilityNote: tokenUtility,
  };
}

export const ETHICAL_CHECKLISTS: EthicalChecklistSeed[] = [
  // --- Proof-of-work settlement networks -----------------------------------
  singlePurpose(
    "BTC",
    "Bitcoin is a decentralised settlement network secured by proof-of-work mining. It moves and stores value; it does not run applications.",
    "BTC pays transaction fees and rewards the miners who secure the network.",
    "BTC has a clear and narrow function: paying for settlement on the network that issues it. It is not a claim on any business or revenue.",
  ),
  singlePurpose(
    "LTC",
    "Litecoin is a long-running proof-of-work payment network derived from Bitcoin, with faster blocks.",
    "LTC pays network transaction fees and rewards miners.",
  ),
  singlePurpose(
    "BCH",
    "Bitcoin Cash is a Bitcoin fork with larger blocks, aimed at low-fee peer-to-peer payments.",
    "BCH pays transaction fees and rewards miners.",
  ),
  {
    ...platform(
      "ETC",
      "Ethereum Classic is the continuation of the original Ethereum chain, retaining proof-of-work consensus and smart contracts.",
      "ETC pays gas for smart contract execution and rewards miners.",
    ),
  },

  // --- Payment networks ----------------------------------------------------
  {
    ...singlePurpose(
      "XRP",
      "The XRP Ledger is a payment-focused network settling transactions in seconds, used for cross-border transfers.",
      "XRP pays (and burns) ledger transaction fees and can act as a bridge asset between currencies.",
    ),
    supportsProhibitedIndustries: "UNCLEAR",
    supportsProhibitedNote:
      "The ledger is open and does not screen participants. It supports issued assets, including ones representing debt instruments, though the ledger itself takes no part in their terms.",
  },
  {
    ...singlePurpose(
      "XLM",
      "Stellar is a payments network for issuing and moving fiat-backed tokens and remittances at low cost.",
      "XLM pays network fees, meets minimum account reserves, and bridges between issued assets.",
    ),
    supportsProhibitedIndustries: "UNCLEAR",
    supportsProhibitedNote:
      "Stellar's model is built around third-party issuers ('anchors'). The protocol does not vet what those issuers represent.",
  },

  // --- General-purpose programmable chains ---------------------------------
  platform(
    "ETH",
    "Ethereum is a programmable blockchain running smart contracts, hosting most on-chain applications and Layer 2 networks.",
    "ETH pays for computation and storage (gas) and is staked by validators to secure the network.",
    { proofOfStake: true },
  ),
  platform(
    "BNB",
    "BNB Chain is a high-throughput smart contract network; BNB is also used across the wider Binance ecosystem.",
    "BNB pays gas fees on BNB Chain and is used for staking and exchange fee discounts.",
    { proofOfStake: true },
  ),
  platform(
    "SOL",
    "Solana is a high-performance Layer 1 optimised for low-cost, high-throughput transactions.",
    "SOL pays network fees, is staked to secure the chain, and covers on-chain storage rent.",
    { proofOfStake: true },
  ),
  platform(
    "ADA",
    "Cardano is a proof-of-stake Layer 1 developed with a research-driven, formally verified engineering approach.",
    "ADA pays transaction fees, is delegated to validators, and is used for on-chain governance.",
    { proofOfStake: true },
  ),
  platform(
    "AVAX",
    "Avalanche is a Layer 1 with a multi-chain architecture allowing applications to run on custom subnets.",
    "AVAX pays fees across Avalanche chains, is staked by validators, and is required to create subnets.",
    { proofOfStake: true },
  ),
  platform(
    "DOT",
    "Polkadot is a network of interoperable blockchains sharing security through a central relay chain.",
    "DOT is staked for security, used in governance, and bonded to secure parachain slots.",
    { proofOfStake: true },
  ),
  platform(
    "ATOM",
    "The Cosmos Hub is the centre of an interoperability-focused ecosystem of sovereign application chains.",
    "ATOM is staked to secure the hub, pays its transaction fees, and carries governance rights.",
    { proofOfStake: true },
  ),
  platform(
    "NEAR",
    "NEAR is a sharded proof-of-stake Layer 1 designed around developer and end-user usability.",
    "NEAR pays transaction and storage fees and is staked by validators securing the shards.",
    { proofOfStake: true },
  ),
  platform(
    "TRX",
    "TRON is a high-throughput Layer 1 widely used for low-cost stablecoin transfers.",
    "TRX is staked for bandwidth and energy resources that pay for on-chain activity, and is used in governance.",
    { proofOfStake: true },
  ),
  platform(
    "APT",
    "Aptos is a Layer 1 using the Move language and parallel execution for high throughput.",
    "APT pays transaction fees and is staked by validators securing the network.",
    { proofOfStake: true },
  ),
  platform(
    "SUI",
    "Sui is a Move-based Layer 1 with an object-centric data model enabling parallel processing.",
    "SUI pays gas and storage fees and is staked with validators.",
    { proofOfStake: true },
  ),
  platform(
    "SEI",
    "Sei is a Layer 1 optimised for trading and exchange applications.",
    "SEI pays network fees, is staked for security, and is used in governance.",
    { proofOfStake: true },
  ),
  {
    ...platform(
      "INJ",
      "Injective is a Cosmos-based Layer 1 purpose-built for financial applications and on-chain orderbooks.",
      "INJ is staked for security, used for governance, and burned through protocol fee auctions.",
      { proofOfStake: true },
    ),
    involvesInterestLending: "UNCLEAR",
    involvesInterestLendingNote: `${PLATFORM_NEUTRALITY} Note that this chain is specifically built for financial applications, so such applications are a larger share of its activity than on a general-purpose chain.`,
    supportsProhibitedIndustries: "UNCLEAR",
    supportsProhibitedNote:
      "The chain is designed for derivatives and financial markets, including instruments that some readers will want to exclude. This is closer to the protocol's stated purpose than it would be on a general-purpose chain.",
  },
  platform(
    "ICP",
    "The Internet Computer hosts full applications and web content directly on-chain.",
    "ICP is converted into cycles that pay for computation and storage, and is staked in governance neurons.",
    { proofOfStake: true },
  ),
  platform(
    "ALGO",
    "Algorand is a pure proof-of-stake Layer 1 focused on instant finality and low cost.",
    "ALGO pays transaction fees and participates in consensus.",
    { proofOfStake: true },
  ),
  platform(
    "XTZ",
    "Tezos is a self-amending proof-of-stake blockchain that upgrades through on-chain governance.",
    "XTZ pays fees, is staked ('baked') to secure the chain, and votes on protocol upgrades.",
    { proofOfStake: true },
  ),
  platform(
    "HBAR",
    "Hedera is an enterprise-oriented public ledger using hashgraph consensus, governed by a council of organisations.",
    "HBAR pays transaction and file-service fees and is staked to nodes.",
    { proofOfStake: true },
  ),
  platform(
    "EGLD",
    "MultiversX is a sharded proof-of-stake Layer 1 focused on scalability and low fees.",
    "EGLD pays transaction and contract fees and is staked to secure the shards.",
    { proofOfStake: true },
  ),
  platform(
    "POL",
    "Polygon is a family of Ethereum scaling networks including a proof-of-stake chain and zero-knowledge rollups.",
    "POL pays fees on Polygon chains and is staked by validators.",
    { proofOfStake: true },
  ),
  platform(
    "ARB",
    "Arbitrum is an Ethereum Layer 2 optimistic rollup scaling Ethereum with lower fees.",
    "ARB is a governance token controlling the Arbitrum DAO treasury and protocol upgrades.",
  ),
  platform(
    "OP",
    "Optimism is an Ethereum Layer 2 rollup and the OP Stack framework behind a network of chains.",
    "OP governs the Optimism Collective, funding public goods and voting on parameters.",
  ),
  platform(
    "IMX",
    "Immutable is an Ethereum Layer 2 built for digital-asset heavy applications, largely games.",
    "IMX pays protocol fees on Immutable X and is staked and used for governance.",
  ),
  platform(
    "STX",
    "Stacks is a Bitcoin Layer 2 bringing smart contracts settled on the Bitcoin blockchain.",
    "STX pays for contract execution and is locked in Stacking to support consensus.",
    { proofOfStake: true },
  ),

  // --- Oracles -------------------------------------------------------------
  {
    ...infrastructure(
      "LINK",
      "Chainlink is a decentralised oracle network delivering off-chain data to smart contracts.",
      "LINK pays node operators for delivering data feeds and is staked as a service-quality guarantee.",
    ),
    supportsGamblingNote:
      "Oracle feeds are consumed by any contract that pays for them, including prediction and betting applications. The network does not choose its consumers.",
  },
  {
    ...infrastructure(
      "PYTH",
      "Pyth is a first-party oracle network publishing high-frequency market data from trading firms and exchanges.",
      "PYTH is used for governance of oracle parameters, data fees and publisher rewards.",
    ),
    supportsProhibitedNote:
      "Its data primarily serves financial and derivatives applications, including instruments some readers will want to exclude.",
  },
  infrastructure(
    "BAND",
    "Band Protocol is a cross-chain oracle network aggregating and delivering real-world data on-chain.",
    "BAND is staked by validators producing data feeds and used for governance.",
  ),

  // --- Infrastructure ------------------------------------------------------
  infrastructure(
    "GRT",
    "The Graph is a decentralised indexing protocol making blockchain data queryable.",
    "GRT pays indexers for serving queries and is staked and delegated to secure indexing.",
  ),
  infrastructure(
    "FIL",
    "Filecoin is a decentralised storage network where providers are paid to store and prove they hold client data.",
    "FIL pays for storage and retrieval deals and is posted as collateral by providers.",
  ),
  infrastructure(
    "AR",
    "Arweave is a permanent storage network where a one-time fee pays for long-term storage.",
    "AR pays the endowment that compensates miners for storing data permanently.",
  ),
  infrastructure(
    "RENDER",
    "Render is a distributed GPU network connecting artists and studios with idle GPU capacity.",
    "RENDER pays node operators for completed rendering and compute jobs.",
  ),
  infrastructure(
    "QNT",
    "Quant builds interoperability software connecting enterprise systems and distributed ledgers.",
    "QNT is used to license and pay for access to Overledger network gateways.",
  ),
  infrastructure(
    "TIA",
    "Celestia is a modular data availability network that other blockchains publish their data to.",
    "TIA pays for blobspace (data availability) and is staked to secure the network.",
  ),
  infrastructure(
    "VET",
    "VeChain is a platform for supply-chain tracking and product provenance.",
    "VET generates VTHO, the resource token paying for transactions and data anchoring.",
  ),

  // --- DeFi ----------------------------------------------------------------
  {
    symbol: "UNI",
    whatProjectDoes:
      "Uniswap is a decentralised exchange protocol that swaps tokens using automated market makers rather than an orderbook.",
    tokenUtility:
      "UNI governs the protocol: fee parameters, treasury spending, and contract upgrades.",
    involvesInterestLending: "NO",
    involvesInterestLendingNote:
      "The protocol swaps assets; it does not lend and charges no interest. Liquidity providers earn a share of trading fees rather than interest on a loan — whether that fee share raises separate questions is worth asking.",
    supportsGambling: "NO",
    supportsGamblingNote:
      "The protocol facilitates asset exchange and offers no betting mechanism.",
    supportsProhibitedIndustries: "UNCLEAR",
    supportsProhibitedNote:
      "Anyone can list any token, so the protocol trades assets of every kind, including ones a reader would want to exclude. It does not curate what is listed.",
    hasClearUtility: "UNCLEAR",
    hasClearUtilityNote:
      "UNI is a governance token. It carries voting rights over the protocol but no claim on its revenue, so its utility depends on how much value the reader places on governance itself.",
  },
  {
    symbol: "AAVE",
    whatProjectDoes:
      "Aave is a decentralised lending market where users supply assets and borrowers pay a variable interest rate.",
    tokenUtility:
      "AAVE governs the protocol and is staked in a Safety Module as backstop capital against shortfalls.",
    involvesInterestLending: "YES",
    involvesInterestLendingNote:
      "Interest-bearing lending is the protocol's core business, not an incidental feature. Suppliers earn interest and borrowers pay it, at algorithmically set rates.",
    supportsGambling: "NO",
    supportsGamblingNote: "The protocol offers no betting mechanism.",
    supportsProhibitedIndustries: "UNCLEAR",
    supportsProhibitedNote:
      "Borrowed funds are unrestricted, and leveraged speculation is a common use of the protocol.",
    hasClearUtility: "YES",
    hasClearUtilityNote:
      "AAVE has a defined role in governance and as backstop capital. The utility is clear; whether the underlying business is acceptable is the question above.",
  },
  {
    symbol: "COMP",
    whatProjectDoes:
      "Compound is an algorithmic money market for supplying and borrowing crypto assets.",
    tokenUtility: "COMP governs market parameters and protocol upgrades.",
    involvesInterestLending: "YES",
    involvesInterestLendingNote:
      "Interest-bearing lending is the protocol's core business. Rates are set algorithmically from supply and demand.",
    supportsGambling: "NO",
    supportsGamblingNote: "The protocol offers no betting mechanism.",
    supportsProhibitedIndustries: "UNCLEAR",
    supportsProhibitedNote: "Borrowed funds are unrestricted and commonly used for leverage.",
    hasClearUtility: "UNCLEAR",
    hasClearUtilityNote: "COMP is purely a governance token with no claim on protocol revenue.",
  },
  {
    symbol: "SKY",
    whatProjectDoes:
      "Sky (formerly Maker) is the governance protocol behind the USDS and DAI stablecoins, which are issued against on-chain collateral.",
    tokenUtility:
      "SKY votes on collateral types and stability-fee parameters, and absorbs bad debt through dilution.",
    involvesInterestLending: "YES",
    involvesInterestLendingNote:
      "Borrowers pay a 'stability fee' on debt drawn against collateral, which functions as interest. The protocol has also allocated reserves into interest-bearing instruments including government bonds.",
    supportsGambling: "NO",
    supportsGamblingNote: "The protocol offers no betting mechanism.",
    supportsProhibitedIndustries: "UNCLEAR",
    supportsProhibitedNote:
      "Reserve allocations have included conventional debt instruments, which is a distinct question from the lending mechanism itself.",
    hasClearUtility: "YES",
    hasClearUtilityNote:
      "SKY has a defined governance and recapitalisation role. The question is the underlying business, not the token's function.",
  },
  {
    symbol: "CRV",
    whatProjectDoes:
      "Curve is a decentralised exchange specialised in low-slippage swaps between similarly priced assets.",
    tokenUtility: "CRV is locked for voting power that directs liquidity incentives across pools.",
    involvesInterestLending: "NO",
    involvesInterestLendingNote:
      "Curve itself is an exchange. Its pools are widely used by lending protocols, but it does not lend or charge interest.",
    supportsGambling: "NO",
    supportsGamblingNote: "The protocol offers no betting mechanism.",
    supportsProhibitedIndustries: "UNCLEAR",
    supportsProhibitedNote:
      "Pools are permissionless and include assets a reader may want to exclude.",
    hasClearUtility: "UNCLEAR",
    hasClearUtilityNote:
      "CRV's main function is directing emissions to pools, a mechanism that exists largely to attract liquidity to the protocol itself.",
  },
  {
    symbol: "LDO",
    whatProjectDoes:
      "Lido is a liquid staking protocol that stakes ETH on a user's behalf and issues a tradable receipt token.",
    tokenUtility: "LDO governs node-operator selection, fee splits and protocol parameters.",
    involvesInterestLending: "NO",
    involvesInterestLendingNote:
      "Lido stakes rather than lends. Staking rewards come from network validation, not from a loan — views differ on how staking rewards should be treated.",
    supportsGambling: "NO",
    supportsGamblingNote: "The protocol offers no betting mechanism.",
    supportsProhibitedIndustries: "NO",
    supportsProhibitedNote: "The protocol's only function is staking infrastructure.",
    hasClearUtility: "UNCLEAR",
    hasClearUtilityNote:
      "LDO is a governance token over a staking service, with no claim on the staking rewards themselves.",
  },
];

export function findChecklist(symbol: string): EthicalChecklistSeed | undefined {
  return ETHICAL_CHECKLISTS.find((c) => c.symbol === symbol.toUpperCase());
}
