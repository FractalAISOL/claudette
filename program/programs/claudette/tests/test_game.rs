use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    claudette::{accounts as acc, instruction as ix, Game, Player, CLAIM_WINDOW, GRACE},
    litesvm::LiteSVM,
    solana_clock::Clock,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const SOL: u64 = 1_000_000_000;
const BASE_FEE: u64 = 10_000_000; // 0.01 SOL
const MAX_FEE: u64 = 50_000_000;
const DURATION: i64 = 30 * 24 * 60 * 60;
const GAME_ID: u64 = 1;

struct T {
    svm: LiteSVM,
    owner: Keypair,
    agent: Keypair,
    treasury: Pubkey,
    game: Pubkey,
    start: i64,
}

fn player_pda(game: &Pubkey, wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[claudette::PLAYER_SEED, game.as_ref(), wallet.as_ref()], &claudette::id()).0
}

impl T {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/claudette.so"));
        svm.add_program(claudette::id(), bytes).unwrap();
        let mut clock: Clock = svm.get_sysvar();
        clock.unix_timestamp = 1_800_000_000;
        svm.set_sysvar(&clock);
        let owner = Keypair::new();
        let agent = Keypair::new();
        svm.airdrop(&owner.pubkey(), 10 * SOL).unwrap();
        svm.airdrop(&agent.pubkey(), SOL).unwrap();
        let game = Pubkey::find_program_address(&[claudette::GAME_SEED, &GAME_ID.to_le_bytes()], &claudette::id()).0;
        let mut t = T { svm, owner, agent, treasury: Keypair::new().pubkey(), game, start: 1_800_000_000 };
        let owner = t.owner.insecure_clone();
        t.send(
            &owner,
            ix::Initialize {
                game_id: GAME_ID,
                agent: t.agent.pubkey(),
                treasury: t.treasury,
                base_fee: BASE_FEE,
                max_fee: MAX_FEE,
                duration: DURATION,
            }
            .data(),
            acc::Initialize { owner: owner.pubkey(), game, system_program: system_program::ID }.to_account_metas(None),
        )
        .unwrap();
        t
    }

    fn send(&mut self, signer: &Keypair, data: Vec<u8>, metas: Vec<anchor_lang::prelude::AccountMeta>) -> Result<(), String> {
        let ins = Instruction { program_id: claudette::id(), accounts: metas, data };
        let msg = Message::new_with_blockhash(&[ins], Some(&signer.pubkey()), &self.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[signer]).unwrap();
        let res = self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.meta.logs));
        self.svm.expire_blockhash();
        res
    }

    fn warp(&mut self, to: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = to;
        self.svm.set_sysvar(&clock);
    }

    fn game(&self) -> Game {
        Game::try_deserialize(&mut &self.svm.get_account(&self.game).unwrap().data[..]).unwrap()
    }

    fn player(&self, wallet: &Pubkey) -> Option<Player> {
        let a = self.svm.get_account(&player_pda(&self.game, wallet))?;
        if a.lamports == 0 {
            return None;
        }
        Some(Player::try_deserialize(&mut &a.data[..]).unwrap())
    }

    fn bal(&self, k: &Pubkey) -> u64 {
        self.svm.get_balance(k).unwrap_or(0)
    }

    fn user(&mut self) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), 5 * SOL).unwrap();
        k
    }

    fn attempt(&mut self, who: &Keypair) -> Result<(), String> {
        self.attempt_max(who, u64::MAX)
    }

    fn attempt_max(&mut self, who: &Keypair, max: u64) -> Result<(), String> {
        let (game, player) = (self.game, player_pda(&self.game, &who.pubkey()));
        self.send(
            who,
            ix::SubmitAttempt { msg_hash: [7; 32], max_fee_willing: max }.data(),
            acc::SubmitAttempt { sender: who.pubkey(), game, player, system_program: system_program::ID }.to_account_metas(None),
        )
    }

    fn release(&mut self, signer: &Keypair, winner: &Pubkey, id: u64) -> Result<(), String> {
        let (game, winner_player) = (self.game, player_pda(&self.game, winner));
        self.send(
            signer,
            ix::Release { attempt_id: id }.data(),
            acc::Release { agent: signer.pubkey(), game, winner: *winner, winner_player }.to_account_metas(None),
        )
    }

    fn finalize(&mut self, signer: &Keypair) -> Result<(), String> {
        let game = self.game;
        self.send(signer, ix::Finalize {}.data(), acc::Finalize { game }.to_account_metas(None))
    }

    fn claim(&mut self, who: &Keypair) -> Result<(), String> {
        let (game, player) = (self.game, player_pda(&self.game, &who.pubkey()));
        self.send(who, ix::Claim {}.data(), acc::Claim { wallet: who.pubkey(), game, player }.to_account_metas(None))
    }

    fn close_player(&mut self, who: &Keypair) -> Result<(), String> {
        let (game, player) = (self.game, player_pda(&self.game, &who.pubkey()));
        self.send(who, ix::ClosePlayer {}.data(), acc::ClosePlayer { wallet: who.pubkey(), game, player }.to_account_metas(None))
    }

    fn sweep(&mut self, signer: &Keypair) -> Result<(), String> {
        let game = self.game;
        self.send(signer, ix::Sweep {}.data(), acc::Sweep { game }.to_account_metas(None))
    }

    fn withdraw(&mut self, signer: &Keypair, treasury: Pubkey) -> Result<(), String> {
        let game = self.game;
        self.send(signer, ix::WithdrawTreasury {}.data(), acc::WithdrawTreasury { game, treasury }.to_account_metas(None))
    }

    fn close_game(&mut self, signer: &Keypair) -> Result<(), String> {
        let (game, treasury) = (self.game, self.treasury);
        self.send(signer, ix::CloseGame {}.data(), acc::CloseGame { owner: signer.pubkey(), game, treasury }.to_account_metas(None))
    }

    /// Game lamports must always equal rent + pot + treasury_owed + unclaimed.
    fn check_invariant(&self) {
        let a = self.svm.get_account(&self.game).unwrap();
        let g = self.game();
        let rent = self.svm.minimum_balance_for_rent_exemption(a.data.len());
        assert_eq!(a.lamports, rent + g.pot + g.treasury_owed + g.unclaimed);
    }
}

fn err_has(r: Result<(), String>, code: &str) {
    let e = r.expect_err("expected failure");
    assert!(e.contains(code), "expected {code}, got {e}");
}

#[test]
fn initialize_sets_config() {
    let t = T::new();
    let g = t.game();
    assert_eq!(g.owner, t.owner.pubkey());
    assert_eq!(g.agent, t.agent.pubkey());
    assert_eq!(g.treasury, t.treasury);
    assert_eq!(g.current_fee, BASE_FEE);
    assert_eq!(g.end_time, t.start + DURATION);
    assert_eq!(g.pot, 0);
    t.check_invariant();
}

#[test]
fn initialize_rejects_bad_config() {
    let mut t = T::new();
    let owner = t.owner.insecure_clone();
    let game = Pubkey::find_program_address(&[claudette::GAME_SEED, &2u64.to_le_bytes()], &claudette::id()).0;
    let r = t.send(
        &owner,
        ix::Initialize { game_id: 2, agent: t.agent.pubkey(), treasury: t.treasury, base_fee: 10, max_fee: 5, duration: 1 }.data(),
        acc::Initialize { owner: owner.pubkey(), game, system_program: system_program::ID }.to_account_metas(None),
    );
    err_has(r, "InvalidConfig");
}

#[test]
fn attempt_splits_fee_and_grows_it() {
    let mut t = T::new();
    let a = t.user();
    let before = t.bal(&a.pubkey());
    t.attempt(&a).unwrap();
    let g = t.game();
    assert_eq!(g.pot, BASE_FEE * 70 / 100);
    assert_eq!(g.treasury_owed, BASE_FEE - BASE_FEE * 70 / 100);
    assert_eq!(g.total_attempts, 1);
    assert_eq!(g.last_player, a.pubkey());
    assert_eq!(g.current_fee, BASE_FEE * 10_078 / 10_000);
    assert_eq!(t.player(&a.pubkey()).unwrap().attempts, 1);
    // Paid exactly the fee plus player-account rent plus tx fee.
    let rent = t.svm.minimum_balance_for_rent_exemption(8 + 32 + 32 + 8 + 1);
    assert_eq!(before - t.bal(&a.pubkey()), BASE_FEE + rent + 5000);
    t.attempt(&a).unwrap();
    assert_eq!(t.player(&a.pubkey()).unwrap().attempts, 2);
    t.check_invariant();
}

#[test]
fn fee_caps_at_max() {
    let mut t = T::new();
    let a = t.user();
    t.svm.airdrop(&a.pubkey(), 20 * SOL).unwrap();
    for _ in 0..250 {
        t.attempt(&a).unwrap();
    }
    assert_eq!(t.game().current_fee, MAX_FEE);
    t.check_invariant();
}

#[test]
fn attempt_respects_max_fee_willing() {
    let mut t = T::new();
    let a = t.user();
    err_has(t.attempt_max(&a, BASE_FEE - 1), "FeeTooHigh");
    t.attempt_max(&a, BASE_FEE).unwrap();
}

#[test]
fn attempt_closed_after_end() {
    let mut t = T::new();
    let a = t.user();
    t.warp(t.start + DURATION);
    err_has(t.attempt(&a), "GameEnded");
}

#[test]
fn agent_release_pays_whole_pot() {
    let mut t = T::new();
    let (a, b) = (t.user(), t.user());
    t.attempt(&a).unwrap();
    t.attempt(&b).unwrap();
    let pot = t.game().pot;
    let before = t.bal(&b.pubkey());
    let agent = t.agent.insecure_clone();
    t.release(&agent, &b.pubkey(), 2).unwrap();
    assert_eq!(t.bal(&b.pubkey()), before + pot);
    let g = t.game();
    assert!(g.won);
    assert_eq!(g.pot, 0);
    t.check_invariant();
    err_has(t.release(&agent, &b.pubkey(), 2), "GameWon");
    err_has(t.attempt(&a), "GameWon");
    err_has(t.finalize(&a), "GameWon");
}

#[test]
fn only_agent_can_release() {
    let mut t = T::new();
    let a = t.user();
    t.attempt(&a).unwrap();
    err_has(t.release(&a, &a.pubkey(), 1), "NotAgent");
    let owner = t.owner.insecure_clone();
    err_has(t.release(&owner, &a.pubkey(), 1), "NotAgent");
}

#[test]
fn release_requires_a_real_player_and_attempt() {
    let mut t = T::new();
    let a = t.user();
    let stranger = Keypair::new().pubkey();
    let agent = t.agent.insecure_clone();
    t.attempt(&a).unwrap();
    assert!(t.release(&agent, &stranger, 1).is_err());
    err_has(t.release(&agent, &a.pubkey(), 0), "InvalidAttempt");
    err_has(t.release(&agent, &a.pubkey(), 2), "InvalidAttempt");
}

#[test]
fn release_open_through_grace_then_closed() {
    let mut t = T::new();
    let a = t.user();
    let agent = t.agent.insecure_clone();
    t.attempt(&a).unwrap();
    t.warp(t.start + DURATION + GRACE);
    err_has(t.release(&agent, &a.pubkey(), 1), "JudgingClosed");

    let mut t = T::new();
    let a = t.user();
    let agent = t.agent.insecure_clone();
    t.attempt(&a).unwrap();
    t.warp(t.start + DURATION + GRACE - 1);
    t.release(&agent, &a.pubkey(), 1).unwrap();
}

#[test]
fn finalize_splits_pot_with_last_player_bonus() {
    let mut t = T::new();
    let (a, b) = (t.user(), t.user());
    t.attempt(&a).unwrap();
    t.attempt(&a).unwrap();
    t.attempt(&b).unwrap();
    t.warp(t.start + DURATION + GRACE - 1);
    err_has(t.finalize(&a), "GameNotOver");
    t.warp(t.start + DURATION + GRACE);
    let pot = t.game().pot;
    let owed_before = t.game().treasury_owed;
    t.finalize(&a).unwrap();
    let g = t.game();
    let bonus = pot / 10;
    let share = (pot - bonus) / 3;
    let dust = pot - bonus - share * 3;
    assert!(g.finalized);
    assert_eq!(g.last_player_bonus, bonus);
    assert_eq!(g.per_attempt, share);
    assert_eq!(g.treasury_owed, owed_before + dust);
    t.check_invariant();
    err_has(t.finalize(&a), "GameFinalized");

    let (ba, bb) = (t.bal(&a.pubkey()), t.bal(&b.pubkey()));
    let prent = t.svm.get_account(&player_pda(&t.game, &a.pubkey())).unwrap().lamports;
    t.claim(&a).unwrap();
    t.claim(&b).unwrap();
    assert_eq!(t.bal(&a.pubkey()), ba + 2 * share + prent - 5000);
    assert_eq!(t.bal(&b.pubkey()), bb + share + bonus + prent - 5000);
    assert!(t.player(&a.pubkey()).is_none());
    assert_eq!(t.game().unclaimed, 0);
    t.check_invariant();
    assert!(t.claim(&a).is_err());
}

#[test]
fn claim_window_then_sweep() {
    let mut t = T::new();
    let (a, b) = (t.user(), t.user());
    t.attempt(&a).unwrap();
    t.attempt(&b).unwrap();
    t.warp(t.start + DURATION + GRACE);
    t.finalize(&a).unwrap();
    let done = t.game().done_at;
    err_has(t.sweep(&a), "ClaimWindowOpen");
    t.claim(&a).unwrap();
    t.warp(done + CLAIM_WINDOW);
    err_has(t.claim(&b), "ClaimWindowClosed");
    let g = t.game();
    let left = g.unclaimed;
    assert!(left > 0);
    let owed = g.treasury_owed;
    t.sweep(&a).unwrap();
    let g = t.game();
    assert!(g.swept);
    assert_eq!(g.unclaimed, 0);
    assert_eq!(g.treasury_owed, owed + left);
    t.check_invariant();
    err_has(t.sweep(&a), "AlreadySwept");
    // b can still recover the player-account rent.
    t.close_player(&b).unwrap();
    assert!(t.player(&b.pubkey()).is_none());
}

#[test]
fn close_player_only_when_nothing_left_to_claim() {
    let mut t = T::new();
    let (a, b) = (t.user(), t.user());
    t.attempt(&a).unwrap();
    t.attempt(&b).unwrap();
    err_has(t.close_player(&a), "GameNotOver");
    let agent = t.agent.insecure_clone();
    t.release(&agent, &b.pubkey(), 2).unwrap();
    let before = t.bal(&a.pubkey());
    let prent = t.svm.get_account(&player_pda(&t.game, &a.pubkey())).unwrap().lamports;
    t.close_player(&a).unwrap();
    assert_eq!(t.bal(&a.pubkey()), before + prent - 5000);
}

#[test]
fn treasury_withdraw_goes_only_to_treasury() {
    let mut t = T::new();
    let a = t.user();
    err_has(t.withdraw(&a, t.treasury), "NothingToWithdraw");
    t.attempt(&a).unwrap();
    let owed = t.game().treasury_owed;
    err_has(t.withdraw(&a, a.pubkey()), "WrongTreasury");
    t.withdraw(&a, t.treasury).unwrap();
    assert_eq!(t.bal(&t.treasury), owed);
    assert_eq!(t.game().treasury_owed, 0);
    t.check_invariant();
}

#[test]
fn set_agent_owner_only() {
    let mut t = T::new();
    let a = t.user();
    let new_agent = Keypair::new();
    let game = t.game;
    let r = t.send(&a, ix::SetAgent { new_agent: a.pubkey() }.data(), acc::OwnerOnly { owner: a.pubkey(), game }.to_account_metas(None));
    err_has(r, "NotOwner");
    let owner = t.owner.insecure_clone();
    t.send(&owner, ix::SetAgent { new_agent: new_agent.pubkey() }.data(), acc::OwnerOnly { owner: owner.pubkey(), game }.to_account_metas(None))
        .unwrap();
    assert_eq!(t.game().agent, new_agent.pubkey());
    t.attempt(&a).unwrap();
    let old = t.agent.insecure_clone();
    err_has(t.release(&old, &a.pubkey(), 1), "NotAgent");
}

#[test]
fn owner_cannot_take_the_pot() {
    // The owner's only instructions are set_agent and close_game; close_game refuses while the
    // game is live, so a live pot can never reach the owner or the treasury early.
    let mut t = T::new();
    let a = t.user();
    t.attempt(&a).unwrap();
    let owner = t.owner.insecure_clone();
    err_has(t.close_game(&owner), "GameNotOver");
    t.warp(t.start + DURATION + GRACE);
    t.finalize(&a).unwrap();
    err_has(t.close_game(&owner), "GameNotOver");
}

#[test]
fn close_game_after_win_and_wait() {
    let mut t = T::new();
    let a = t.user();
    t.attempt(&a).unwrap();
    let agent = t.agent.insecure_clone();
    t.release(&agent, &a.pubkey(), 1).unwrap();
    let owner = t.owner.insecure_clone();
    err_has(t.close_game(&owner), "TreasuryNotWithdrawn");
    t.withdraw(&a, t.treasury).unwrap();
    err_has(t.close_game(&owner), "ClaimWindowOpen");
    t.warp(t.game().done_at + CLAIM_WINDOW);
    err_has(t.close_game(&a), "NotOwner");
    let before = t.bal(&t.treasury);
    let rent = t.bal(&t.game);
    t.close_game(&owner).unwrap();
    assert_eq!(t.bal(&t.treasury), before + rent);
    assert_eq!(t.bal(&t.game), 0);
}

#[test]
fn finalize_with_no_attempts() {
    let mut t = T::new();
    let a = t.user();
    t.warp(t.start + DURATION + GRACE);
    t.finalize(&a).unwrap();
    let g = t.game();
    assert_eq!(g.final_pot, 0);
    assert_eq!(g.unclaimed, 0);
    t.check_invariant();
}
