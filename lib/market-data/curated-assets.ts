/**
 * Curated spot-trading universe.
 *
 * This list is the single source of truth for the whitelist: `prisma/seed.ts`
 * writes it into Postgres, and the market service falls back to reading it
 * directly when no database is configured (early-phase local dev).
 *
 * Inclusion rules (see PRD "Core Principles"):
 *  - established projects with a real, describable utility
 *  - no meme coins, no gambling-first projects
 *  - spot pairs only; SpotLens never touches futures/margin markets
 *
 * From Phase 6 this becomes admin-editable in the database; the file stays the
 * bootstrap/seed source.
 */

export type AssetCategory =
  "LAYER1" | "LAYER2" | "INFRASTRUCTURE" | "ORACLE" | "DEFI_INFRASTRUCTURE" | "PAYMENTS" | "OTHER";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

export interface CuratedAsset {
  symbol: string;
  name: string;
  category: AssetCategory;
  officialWebsite: string;
  description: string;
  utilityExplanation: string;
  riskLevel: RiskLevel;
  /** Quote currencies to create trading pairs for (exchange symbol = symbol + quote). */
  quoteCurrencies: string[];
}

const USDT = ["USDT"];

export const CURATED_ASSETS: CuratedAsset[] = [
  {
    symbol: "BTC",
    name: "Bitcoin",
    category: "LAYER1",
    officialWebsite: "https://bitcoin.org",
    description:
      "The first and largest cryptocurrency, a decentralised settlement network secured by proof-of-work mining.",
    utilityExplanation:
      "BTC pays transaction fees on the Bitcoin network and rewards miners who secure it. It is most commonly held as a long-term store of value.",
    riskLevel: "LOW",
    quoteCurrencies: USDT,
  },
  {
    symbol: "ETH",
    name: "Ethereum",
    category: "LAYER1",
    officialWebsite: "https://ethereum.org",
    description:
      "A programmable blockchain that runs smart contracts, hosting the majority of on-chain applications and Layer 2 networks.",
    utilityExplanation:
      "ETH pays for computation and storage (gas) on Ethereum and is staked by validators to secure the network.",
    riskLevel: "LOW",
    quoteCurrencies: USDT,
  },
  {
    symbol: "BNB",
    name: "BNB",
    category: "LAYER1",
    officialWebsite: "https://www.bnbchain.org",
    description:
      "Native asset of BNB Chain, a high-throughput smart contract network, also used across the Binance ecosystem.",
    utilityExplanation:
      "BNB pays gas fees on BNB Chain and is used for staking and fee discounts within its ecosystem.",
    riskLevel: "MEDIUM",
    quoteCurrencies: USDT,
  },
  {
    symbol: "SOL",
    name: "Solana",
    category: "LAYER1",
    officialWebsite: "https://solana.com",
    description:
      "A high-performance Layer 1 blockchain optimised for low-cost, high-throughput transactions.",
    utilityExplanation:
      "SOL pays network fees, is staked to secure the chain, and covers rent for on-chain account storage.",
    riskLevel: "MEDIUM",
    quoteCurrencies: USDT,
  },
  {
    symbol: "ADA",
    name: "Cardano",
    category: "LAYER1",
    officialWebsite: "https://cardano.org",
    description:
      "A proof-of-stake Layer 1 blockchain developed with a research-driven, formally-verified engineering approach.",
    utilityExplanation:
      "ADA pays transaction fees, is staked to delegate to network validators, and is used for on-chain governance voting.",
    riskLevel: "MEDIUM",
    quoteCurrencies: USDT,
  },
  {
    symbol: "AVAX",
    name: "Avalanche",
    category: "LAYER1",
    officialWebsite: "https://www.avax.network",
    description:
      "A Layer 1 platform with a multi-chain architecture allowing applications to run on custom subnets.",
    utilityExplanation:
      "AVAX pays fees across Avalanche chains, is staked by validators, and is required to create subnets.",
    riskLevel: "MEDIUM",
    quoteCurrencies: USDT,
  },
  {
    symbol: "DOT",
    name: "Polkadot",
    category: "LAYER1",
    officialWebsite: "https://polkadot.com",
    description:
      "A network of interoperable blockchains sharing a common security layer through its relay chain.",
    utilityExplanation:
      "DOT is staked for network security, used in governance, and bonded to secure parachain slots.",
    riskLevel: "MEDIUM",
    quoteCurrencies: USDT,
  },
  {
    symbol: "ATOM",
    name: "Cosmos Hub",
    category: "LAYER1",
    officialWebsite: "https://cosmos.network",
    description:
      "The hub of the Cosmos ecosystem, an interoperability-focused network of sovereign application chains.",
    utilityExplanation:
      "ATOM is staked to secure the Cosmos Hub, pays its transaction fees, and carries governance rights.",
    riskLevel: "MEDIUM",
    quoteCurrencies: USDT,
  },
  {
    symbol: "NEAR",
    name: "NEAR Protocol",
    category: "LAYER1",
    officialWebsite: "https://near.org",
    description:
      "A sharded proof-of-stake Layer 1 designed around developer and end-user usability.",
    utilityExplanation:
      "NEAR pays transaction and storage fees, and is staked by validators securing the shards.",
    riskLevel: "MEDIUM",
    quoteCurrencies: USDT,
  },
  {
    symbol: "TRX",
    name: "TRON",
    category: "LAYER1",
    officialWebsite: "https://tron.network",
    description: "A high-throughput Layer 1 network widely used for low-cost stablecoin transfers.",
    utilityExplanation:
      "TRX is staked for bandwidth and energy resources that pay for on-chain activity, and is used in governance.",
    riskLevel: "MEDIUM",
    quoteCurrencies: USDT,
  },
  {
    symbol: "APT",
    name: "Aptos",
    category: "LAYER1",
    officialWebsite: "https://aptosfoundation.org",
    description:
      "A Layer 1 blockchain using the Move language and parallel execution for high throughput.",
    utilityExplanation:
      "APT pays transaction fees and is staked by validators securing the network.",
    riskLevel: "HIGH",
    quoteCurrencies: USDT,
  },
  {
    symbol: "SUI",
    name: "Sui",
    category: "LAYER1",
    officialWebsite: "https://sui.io",
    description:
      "A Move-based Layer 1 with an object-centric data model enabling parallel transaction processing.",
    utilityExplanation:
      "SUI pays gas and storage fees and is staked with validators to secure the network.",
    riskLevel: "HIGH",
    quoteCurrencies: USDT,
  },
  {
    symbol: "SEI",
    name: "Sei",
    category: "LAYER1",
    officialWebsite: "https://www.sei.io",
    description: "A Layer 1 blockchain optimised for trading and exchange applications.",
    utilityExplanation:
      "SEI pays network fees, is staked for security, and is used in protocol governance.",
    riskLevel: "HIGH",
    quoteCurrencies: USDT,
  },
  {
    symbol: "INJ",
    name: "Injective",
    category: "LAYER1",
    officialWebsite: "https://injective.com",
    description:
      "A Cosmos-based Layer 1 purpose-built for financial applications and on-chain orderbooks.",
    utilityExplanation:
      "INJ is staked for network security, used for governance, and burned through protocol fee auctions.",
    riskLevel: "HIGH",
    quoteCurrencies: USDT,
  },
  {
    symbol: "TIA",
    name: "Celestia",
    category: "INFRASTRUCTURE",
    officialWebsite: "https://celestia.org",
    description:
      "A modular data availability network that other blockchains use to publish and verify their data.",
    utilityExplanation:
      "TIA pays for blobspace (data availability) and is staked to secure the network.",
    riskLevel: "HIGH",
    quoteCurrencies: USDT,
  },
  {
    symbol: "ICP",
    name: "Internet Computer",
    category: "LAYER1",
    officialWebsite: "https://internetcomputer.org",
    description:
      "A Layer 1 network that hosts full applications and web content directly on-chain.",
    utilityExplanation:
      "ICP is converted into cycles that pay for computation and storage, and is staked in governance neurons.",
    riskLevel: "HIGH",
    quoteCurrencies: USDT,
  },
  {
    symbol: "ALGO",
    name: "Algorand",
    category: "LAYER1",
    officialWebsite: "https://algorand.co",
    description:
      "A pure proof-of-stake Layer 1 focused on instant finality and low transaction cost.",
    utilityExplanation:
      "ALGO pays transaction fees and participates in consensus through participation keys.",
    riskLevel: "MEDIUM",
    quoteCurrencies: USDT,
  },
  {
    symbol: "XTZ",
    name: "Tezos",
    category: "LAYER1",
    officialWebsite: "https://tezos.com",
    description:
      "A self-amending proof-of-stake blockchain that upgrades itself through on-chain governance.",
    utilityExplanation:
      "XTZ pays fees, is staked ('baked') to secure the chain, and votes on protocol upgrades.",
    riskLevel: "MEDIUM",
    quoteCurrencies: USDT,
  },
  {
    symbol: "HBAR",
    name: "Hedera",
    category: "LAYER1",
    officialWebsite: "https://hedera.com",
    description:
      "An enterprise-oriented public ledger using a hashgraph consensus algorithm, governed by a council of organisations.",
    utilityExplanation:
      "HBAR pays network transaction and file-service fees and is staked to nodes for consensus weight.",
    riskLevel: "MEDIUM",
    quoteCurrencies: USDT,
  },
  {
    symbol: "EGLD",
    name: "MultiversX",
    category: "LAYER1",
    officialWebsite: "https://multiversx.com",
    description: "A sharded proof-of-stake Layer 1 focused on scalability and low fees.",
    utilityExplanation:
      "EGLD pays transaction and smart contract fees and is staked to secure the shards.",
    riskLevel: "HIGH",
    quoteCurrencies: USDT,
  },
  {
    symbol: "ETC",
    name: "Ethereum Classic",
    category: "LAYER1",
    officialWebsite: "https://ethereumclassic.org",
    description:
      "The continuation of the original Ethereum chain, retaining proof-of-work consensus.",
    utilityExplanation:
      "ETC pays gas for smart contract execution and rewards the miners securing the chain.",
    riskLevel: "MEDIUM",
    quoteCurrencies: USDT,
  },
  {
    symbol: "VET",
    name: "VeChain",
    category: "INFRASTRUCTURE",
    officialWebsite: "https://www.vechain.org",
    description:
      "A blockchain platform aimed at supply-chain tracking and enterprise product provenance.",
    utilityExplanation:
      "VET generates VTHO, the resource token that pays for on-chain transactions and data anchoring.",
    riskLevel: "HIGH",
    quoteCurrencies: USDT,
  },
  {
    symbol: "ARB",
    name: "Arbitrum",
    category: "LAYER2",
    officialWebsite: "https://arbitrum.io",
    description:
      "An Ethereum Layer 2 optimistic rollup that scales Ethereum with lower fees and the same security assumptions.",
    utilityExplanation:
      "ARB is a governance token controlling the Arbitrum DAO treasury and protocol upgrades.",
    riskLevel: "MEDIUM",
    quoteCurrencies: USDT,
  },
  {
    symbol: "OP",
    name: "Optimism",
    category: "LAYER2",
    officialWebsite: "https://www.optimism.io",
    description:
      "An Ethereum Layer 2 rollup and the OP Stack framework powering a network of interoperable chains.",
    utilityExplanation:
      "OP governs the Optimism Collective, funding public goods and voting on protocol parameters.",
    riskLevel: "MEDIUM",
    quoteCurrencies: USDT,
  },
  {
    symbol: "POL",
    name: "Polygon",
    category: "LAYER2",
    officialWebsite: "https://polygon.technology",
    description:
      "A family of Ethereum scaling networks including a PoS chain and zero-knowledge rollups.",
    utilityExplanation:
      "POL pays fees on Polygon chains and is staked by validators securing the network.",
    riskLevel: "MEDIUM",
    quoteCurrencies: USDT,
  },
  {
    symbol: "IMX",
    name: "Immutable",
    category: "LAYER2",
    officialWebsite: "https://www.immutable.com",
    description:
      "An Ethereum Layer 2 built for digital-asset heavy applications with gas-free minting and trading.",
    utilityExplanation:
      "IMX pays protocol fees on Immutable X and is staked and used for governance.",
    riskLevel: "HIGH",
    quoteCurrencies: USDT,
  },
  {
    symbol: "STX",
    name: "Stacks",
    category: "LAYER2",
    officialWebsite: "https://www.stacks.co",
    description: "A Bitcoin Layer 2 bringing smart contracts settled on the Bitcoin blockchain.",
    utilityExplanation:
      "STX pays for smart contract execution and is locked in Stacking to support consensus.",
    riskLevel: "HIGH",
    quoteCurrencies: USDT,
  },
  {
    symbol: "LINK",
    name: "Chainlink",
    category: "ORACLE",
    officialWebsite: "https://chain.link",
    description:
      "The most widely used decentralised oracle network, feeding off-chain data into smart contracts.",
    utilityExplanation:
      "LINK pays node operators for delivering data feeds and is staked as a service-quality guarantee.",
    riskLevel: "LOW",
    quoteCurrencies: USDT,
  },
  {
    symbol: "PYTH",
    name: "Pyth Network",
    category: "ORACLE",
    officialWebsite: "https://www.pyth.network",
    description:
      "A first-party oracle network publishing high-frequency market data from trading firms and exchanges.",
    utilityExplanation:
      "PYTH is used for governance of oracle parameters, data fees, and publisher rewards.",
    riskLevel: "HIGH",
    quoteCurrencies: USDT,
  },
  {
    symbol: "BAND",
    name: "Band Protocol",
    category: "ORACLE",
    officialWebsite: "https://www.bandprotocol.com",
    description:
      "A cross-chain oracle network aggregating and delivering real-world data on-chain.",
    utilityExplanation:
      "BAND is staked by validators producing data feeds and used for network governance.",
    riskLevel: "HIGH",
    quoteCurrencies: USDT,
  },
  {
    symbol: "GRT",
    name: "The Graph",
    category: "INFRASTRUCTURE",
    officialWebsite: "https://thegraph.com",
    description:
      "A decentralised indexing protocol that makes blockchain data queryable for applications.",
    utilityExplanation:
      "GRT pays indexers for serving queries and is staked and delegated to secure the indexing network.",
    riskLevel: "MEDIUM",
    quoteCurrencies: USDT,
  },
  {
    symbol: "FIL",
    name: "Filecoin",
    category: "INFRASTRUCTURE",
    officialWebsite: "https://filecoin.io",
    description:
      "A decentralised storage network where providers are paid to store and prove they hold client data.",
    utilityExplanation:
      "FIL pays for storage and retrieval deals and is collateralised by storage providers.",
    riskLevel: "MEDIUM",
    quoteCurrencies: USDT,
  },
  {
    symbol: "AR",
    name: "Arweave",
    category: "INFRASTRUCTURE",
    officialWebsite: "https://www.arweave.org",
    description:
      "A permanent storage network where a one-time fee pays for long-term data storage.",
    utilityExplanation:
      "AR pays the endowment that compensates miners for storing data permanently.",
    riskLevel: "HIGH",
    quoteCurrencies: USDT,
  },
  {
    symbol: "RENDER",
    name: "Render Network",
    category: "INFRASTRUCTURE",
    officialWebsite: "https://rendernetwork.com",
    description:
      "A distributed GPU rendering network connecting artists and studios with idle GPU capacity.",
    utilityExplanation: "RENDER pays node operators for completed rendering and compute jobs.",
    riskLevel: "HIGH",
    quoteCurrencies: USDT,
  },
  {
    symbol: "QNT",
    name: "Quant",
    category: "INFRASTRUCTURE",
    officialWebsite: "https://quant.network",
    description:
      "Interoperability software connecting enterprise systems and multiple distributed ledgers.",
    utilityExplanation:
      "QNT is used to license and pay for access to the Overledger network gateways.",
    riskLevel: "HIGH",
    quoteCurrencies: USDT,
  },
  {
    symbol: "UNI",
    name: "Uniswap",
    category: "DEFI_INFRASTRUCTURE",
    officialWebsite: "https://uniswap.org",
    description:
      "The largest decentralised exchange protocol, using automated market makers instead of orderbooks.",
    utilityExplanation:
      "UNI governs the protocol: fee parameters, treasury spending, and contract upgrades.",
    riskLevel: "MEDIUM",
    quoteCurrencies: USDT,
  },
  {
    symbol: "AAVE",
    name: "Aave",
    category: "DEFI_INFRASTRUCTURE",
    officialWebsite: "https://aave.com",
    description:
      "A decentralised lending market where users supply assets and borrowers pay a variable interest rate.",
    utilityExplanation:
      "AAVE governs the protocol and is staked in the Safety Module as backstop capital. Note: this protocol's core business is interest-bearing lending — see the ethical research checklist.",
    riskLevel: "MEDIUM",
    quoteCurrencies: USDT,
  },
  {
    symbol: "SKY",
    name: "Sky (formerly Maker)",
    category: "DEFI_INFRASTRUCTURE",
    officialWebsite: "https://sky.money",
    description:
      "The governance protocol behind the USDS/DAI stablecoins, backed by on-chain collateral vaults.",
    utilityExplanation:
      "SKY votes on collateral and stability-fee parameters and absorbs bad debt via dilution. Note: vaults charge stability fees — see the ethical research checklist.",
    riskLevel: "MEDIUM",
    quoteCurrencies: USDT,
  },
  {
    symbol: "CRV",
    name: "Curve DAO",
    category: "DEFI_INFRASTRUCTURE",
    officialWebsite: "https://curve.finance",
    description:
      "A decentralised exchange specialised in low-slippage swaps between similarly-priced assets.",
    utilityExplanation:
      "CRV is locked for voting power that directs liquidity incentives across pools.",
    riskLevel: "HIGH",
    quoteCurrencies: USDT,
  },
  {
    symbol: "LDO",
    name: "Lido DAO",
    category: "DEFI_INFRASTRUCTURE",
    officialWebsite: "https://lido.fi",
    description: "A liquid staking protocol issuing a tradable receipt token for staked ETH.",
    utilityExplanation: "LDO governs node-operator selection, fee splits, and protocol parameters.",
    riskLevel: "HIGH",
    quoteCurrencies: USDT,
  },
  {
    symbol: "COMP",
    name: "Compound",
    category: "DEFI_INFRASTRUCTURE",
    officialWebsite: "https://compound.finance",
    description: "An algorithmic money market protocol for supplying and borrowing crypto assets.",
    utilityExplanation:
      "COMP governs market parameters and protocol upgrades. Note: the protocol's core business is interest-bearing lending — see the ethical research checklist.",
    riskLevel: "HIGH",
    quoteCurrencies: USDT,
  },
  {
    symbol: "XRP",
    name: "XRP",
    category: "PAYMENTS",
    officialWebsite: "https://xrpl.org",
    description:
      "The native asset of the XRP Ledger, a payment-focused network settling transactions in seconds.",
    utilityExplanation:
      "XRP pays (and burns) ledger transaction fees and acts as a bridge asset for cross-border payments.",
    riskLevel: "MEDIUM",
    quoteCurrencies: USDT,
  },
  {
    symbol: "LTC",
    name: "Litecoin",
    category: "PAYMENTS",
    officialWebsite: "https://litecoin.org",
    description:
      "A long-running proof-of-work payment network derived from Bitcoin with faster block times.",
    utilityExplanation: "LTC pays network transaction fees and rewards the miners securing it.",
    riskLevel: "MEDIUM",
    quoteCurrencies: USDT,
  },
  {
    symbol: "BCH",
    name: "Bitcoin Cash",
    category: "PAYMENTS",
    officialWebsite: "https://bch.info",
    description: "A Bitcoin fork with larger blocks, positioned for low-fee peer-to-peer payments.",
    utilityExplanation: "BCH pays transaction fees and rewards miners securing the chain.",
    riskLevel: "MEDIUM",
    quoteCurrencies: USDT,
  },
  {
    symbol: "XLM",
    name: "Stellar",
    category: "PAYMENTS",
    officialWebsite: "https://stellar.org",
    description:
      "A payments network for issuing and moving fiat-backed tokens and remittances at low cost.",
    utilityExplanation:
      "XLM pays network fees, meets minimum account reserves, and bridges between issued assets.",
    riskLevel: "MEDIUM",
    quoteCurrencies: USDT,
  },
];

/** Exchange-native symbol for a curated asset + quote pair (e.g. BTC + USDT -> BTCUSDT). */
export function toExchangeSymbol(assetSymbol: string, quoteCurrency: string): string {
  return `${assetSymbol}${quoteCurrency}`.toUpperCase();
}

export function findCuratedAsset(symbol: string): CuratedAsset | undefined {
  return CURATED_ASSETS.find((a) => a.symbol === symbol.toUpperCase());
}
