import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Stake2wake } from "../target/types/stake2wake";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import { assert, use } from "chai";
import { BN } from "bn.js";

describe("stake2wake", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();

  anchor.setProvider(provider);

  const program = anchor.workspace.Stake2wake as Program<Stake2wake>;

  const admin = provider.wallet;
  let user: Keypair;

  let userAta: PublicKey; // this account will store the BONK tokens for the user
  let bonkMint: PublicKey; // this is the mint for BONK tokens
  let bonkAta: PublicKey; // this is the associated token account for BONK tokens
  let treasuryPda: PublicKey; // this account will store the treasury details
  let treasuryAta: PublicKey; // this is the associated token account for the treasury
  let treasuryBump: number; // this is the bump seed for the treasury PDA
  let userChallangePda: PublicKey; // this account stores the challenge details
  let vaultAta: PublicKey; // account where we store the staked amount

  // challenge time is derived globally because other functions will use
  // from this we need to derive the pda aswell
  const startTime = Math.floor(Date.now() / 1000); // Convert milliseconds to seconds
  const startTimeBuf = Buffer.alloc(8); // 8 bytes for BigInt64

  const CHALLENGE_DURATION_IN_SECONDS = 4; // 5 seconds for testing purposes
  const totalTime = new BN(startTime + CHALLENGE_DURATION_IN_SECONDS); // Total time in seconds
  const wakeupTime = new BN(totalTime); // Wakeup time in seconds
  startTimeBuf.writeBigInt64LE(BigInt(startTime)); // write start time to buffer

  before(async () => {
    user = anchor.web3.Keypair.generate();

    // Airdrop SOL to the user account
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        user.publicKey,
        2 * LAMPORTS_PER_SOL
      ),
      "confirmed"
    );

    // Create a mint for BONK tokens
    // This mint will be used for staking in the challenge
    bonkMint = await createMint(
      provider.connection,
      admin.payer,
      admin.publicKey,
      null,
      6
    );

    // Create the associated token account for the user
    // This account will store the BONK tokens for the user
    userAta = await createAssociatedTokenAccount(
      provider.connection,
      user,
      bonkMint,
      user.publicKey
    );

    // Mint some BONK tokens to the admin's associated token account
    await mintTo(
      provider.connection,
      admin.payer,
      bonkMint,
      userAta,
      admin.publicKey,
      1_000_000_000
    );

    // Create the PDA for the user challenge account
    [userChallangePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("challenge"), user.publicKey.toBuffer(), startTimeBuf],
      program.programId
    );

    // Create the associated token account for the user where the BONK tokens will be stored
    bonkAta = getAssociatedTokenAddressSync(bonkMint, admin.publicKey, true);

    // Create the PDA for the treasury account
    [treasuryPda, treasuryBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury"), admin.publicKey.toBuffer()],
      program.programId
    );

    // create the associated token account for the treasury where the collected BONK will be stored
    treasuryAta = getAssociatedTokenAddressSync(bonkMint, treasuryPda, true);

    // Create the associated token account for the vault where the staked amount will be stored
    vaultAta = getAssociatedTokenAddressSync(bonkMint, userChallangePda, true);
  });

  it("Should initialize the treasury!", async () => {
    // Add your test here.
    const tx = await program.methods
      .initialize()
      .accountsPartial({
        authority: admin.publicKey,
        bonkMint: bonkMint,
        treasury: treasuryPda,
        treasuryAta: treasuryAta,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([])
      .rpc();
    console.log("Your transaction signature", tx);

    const treasuryAccount = await program.account.treasury.fetch(treasuryPda);
    console.log("treasuryAccount", treasuryAccount);

    assert.equal(
      treasuryAccount.authority.toBase58(),
      admin.publicKey.toBase58()
    );
    assert.equal(treasuryAccount.bonkMint.toBase58(), bonkMint.toBase58());
    assert.equal(
      treasuryAccount.treasuryAta.toBase58(),
      treasuryAta.toBase58()
    );
    assert.equal(treasuryAccount.bump, treasuryBump);
    assert.equal(treasuryAccount.totalCollected.toNumber(), 0);
  });

  it("Should fail if the non-admin tries to initialize the treasury", async () => {
    let error = false;
    try {
      const tx = await program.methods
        .initialize()
        .accountsPartial({
          authority: user.publicKey,
          bonkMint: bonkMint,
          treasury: treasuryPda,
          treasuryAta: treasuryAta,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      console.log("Your transaction signature", tx);
    } catch (err) {
      error = true;
      console.log("Expected error:", err.error?.errorMessage || err.message);
    }
    // other than admin no one has the access to initialize the treasury
    assert.isTrue(error, "Expected the transaction to fail, but it succeeded");
  });

  it("starts a challenge", async () => {
    // giving challenge a 5 secs duration which will be helpful for testing

    const stakeAmount = new BN(1 * LAMPORTS_PER_SOL);
    const totalDays = new BN(1);

    const tx = await program.methods
      .startChallenge(new BN(startTime), wakeupTime, stakeAmount, totalDays)
      .accountsPartial({
        bonkMint,
        user: user.publicKey,
        userChallenge: userChallangePda,
        vault: vaultAta,
      })
      .signers([user])
      .rpc();

    console.log("Your transaction signature", tx);

    const userAccount = await program.account.challengeAccount.fetch(
      userChallangePda
    );
    console.log("userAccount", userAccount);
    assert.equal(userAccount.user.toBase58(), user.publicKey.toBase58());
    assert.equal(userAccount.vault.toBase58(), vaultAta.toBase58());
    assert.equal(userAccount.startTime.toNumber(), startTime);
    assert.equal(userAccount.wakeupTime.toNumber(), wakeupTime.toNumber());
    assert.equal(userAccount.stakeAmount.toNumber(), stakeAmount.toNumber());
    assert.equal(userAccount.totalDays.toNumber(), totalDays.toNumber());
    assert.equal(userAccount.mint.toBase58(), bonkMint.toBase58());
  });

  it("checks in correctly", async () => {
    // Add your test logic here.
    const tx = await program.methods
      .checkStatus()
      .accountsPartial({
        bonkMint,
        treasury: treasuryPda,
        treasuryAta: treasuryAta,
        user: user.publicKey,
        userChallenge: userChallangePda,
        vault: vaultAta,
        userTokenAccount: userAta,
      })
      .signers([user])
      .rpc();
    console.log("Your transaction signature", tx);
    const userAccount = await program.account.challengeAccount.fetch(
      userChallangePda
    );
    console.log("userAccount after checkStatus", userAccount);
    assert.equal(userAccount.isActive, false);
  });

  // for this test to work we need to wait for the challenge duration to pass
  it.skip("fails outside wakeup time", async () => {
    // Add your test logic here.
    await new Promise((r) => setTimeout(r, 5 * 1000)); // wait for 2 minutes to ensure we are outside the wakeup time
    let error = false;
    try {
      const tx = await program.methods
        .checkStatus()
        .accountsPartial({
          bonkMint,
          treasury: treasuryPda,
          treasuryAta: treasuryAta,
          user: user.publicKey,
          userChallenge: userChallangePda,
          vault: vaultAta,
          userTokenAccount: userAta,
        })
        .signers([user])
        .rpc();
      console.log("Your transaction signature", tx);
    } catch (err) {
      error = true;
      console.log("Expected error:", err.error?.errorMessage || err.message);
    }
    assert.isTrue(error, "Expected the transaction to fail, but it succeeded");
  });

  it("fails to check twice", async () => {
    // Add your test logic here.
    let error = false;
    try {
      const tx = await program.methods
        .checkStatus()
        .accountsPartial({
          bonkMint,
          treasury: treasuryPda,
          treasuryAta: treasuryAta,
          user: user.publicKey,
          userChallenge: userChallangePda,
          vault: vaultAta,
          userTokenAccount: userAta,
        })
        .signers([user])
        .rpc();
      console.log("Your transaction signature", tx);
    } catch (err) {
      error = true;
      console.log("Expected error:", err.error?.errorMessage || err.message);
    }
    assert.isTrue(error, "Expected the transaction to fail, but it succeeded");
  });

  it("cancels challenge with full refund", async () => {
    // Add your test logic here.
  });

  it("cancels early with 20% penalty", async () => {
    // Add your test logic here.
  });

  it("withdraws from treasury", async () => {
    // Add your test logic here.
  });

  it("fails withdraw for non-admin", async () => {
    // Add your test logic here.
  });
});
