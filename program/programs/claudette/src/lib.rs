//! Claudette: pay a rising fee to send Claudette one message. Convince her and the pot is yours.
//!
//! Messages live off-chain; only their hash is committed here (in the `AttemptSubmitted` event).
//! The agent key judges and calls `release`. If nobody wins by `end_time + GRACE`, anyone can
//! `finalize` and every attempt gets an equal share of the pot, with a 10% bonus for the last
//! player. Shares can be claimed for `CLAIM_WINDOW`; after that `sweep` moves what is left to the
//! treasury. The owner can only rotate the agent key and close a finished game; there is no path
//! for the owner to move the pot.
//!
//! Lamport invariant on the game account: rent + pot + treasury_owed + unclaimed.

use anchor_lang::prelude::*;

declare_id!("727pxDqXaRPdAJwb5DW8LtXJHPyPH3yoYfNzPeymhLB5");

/// Fee growth per attempt, in bps (fee *= 1.0078).
pub const GROWTH_BPS: u64 = 78;
const BPS: u64 = 10_000;
/// Share of each fee that goes to the pot, in percent. The rest accrues to treasury.
pub const POT_SHARE_PCT: u64 = 70;
/// Share of the pot paid to the last player when nobody wins, in percent.
pub const LAST_PLAYER_BONUS_PCT: u64 = 10;
/// Window after `end_time` in which the agent can still judge pre-end attempts.
pub const GRACE: i64 = 60 * 60;
/// How long shares stay claimable after `finalize`, and how long players have to recover their
/// player-account rent before the owner may close a finished game.
pub const CLAIM_WINDOW: i64 = 30 * 24 * 60 * 60;

pub const GAME_SEED: &[u8] = b"game";
pub const PLAYER_SEED: &[u8] = b"player";

#[program]
pub mod claudette {
    use super::*;

    /// Create game `game_id`. The signer becomes owner and pays rent.
    pub fn initialize(
        ctx: Context<Initialize>,
        game_id: u64,
        agent: Pubkey,
        treasury: Pubkey,
        base_fee: u64,
        max_fee: u64,
        duration: i64,
    ) -> Result<()> {
        require!(agent != Pubkey::default() && treasury != Pubkey::default(), ClaudetteError::ZeroAddress);
        require!(base_fee > 0 && max_fee >= base_fee && duration > 0, ClaudetteError::InvalidConfig);
        let now = Clock::get()?.unix_timestamp;
        let g = &mut ctx.accounts.game;
        g.game_id = game_id;
        g.owner = ctx.accounts.owner.key();
        g.agent = agent;
        g.treasury = treasury;
        g.max_fee = max_fee;
        g.end_time = now.checked_add(duration).ok_or(ClaudetteError::InvalidConfig)?;
        g.current_fee = base_fee;
        g.bump = ctx.bumps.game;
        emit!(AgentUpdated { previous_agent: Pubkey::default(), new_agent: agent });
        Ok(())
    }

    // ─── Play ────────────────────────────────────────────────────────────────

    /// Pay `current_fee` to commit one message. Fails if the fee has risen above `max_fee_willing`.
    pub fn submit_attempt(ctx: Context<SubmitAttempt>, msg_hash: [u8; 32], max_fee_willing: u64) -> Result<()> {
        let g = &mut ctx.accounts.game;
        require!(!g.won, ClaudetteError::GameWon);
        require!(!g.finalized, ClaudetteError::GameFinalized);
        require!(Clock::get()?.unix_timestamp < g.end_time, ClaudetteError::GameEnded);
        let fee = g.current_fee;
        require!(fee <= max_fee_willing, ClaudetteError::FeeTooHigh);

        anchor_lang::system_program::transfer(
            CpiContext::new(
                anchor_lang::system_program::ID,
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.sender.to_account_info(),
                    to: g.to_account_info(),
                },
            ),
            fee,
        )?;

        let to_pot = fee * POT_SHARE_PCT / 100;
        g.pot += to_pot;
        g.treasury_owed += fee - to_pot;
        g.total_attempts += 1;
        g.last_player = ctx.accounts.sender.key();
        let next = (fee as u128 * (BPS + GROWTH_BPS) as u128 / BPS as u128) as u64;
        g.current_fee = next.min(g.max_fee);

        let p = &mut ctx.accounts.player;
        if p.attempts == 0 {
            p.game = g.key();
            p.wallet = ctx.accounts.sender.key();
            p.bump = ctx.bumps.player;
        }
        p.attempts += 1;

        emit!(AttemptSubmitted {
            game: g.key(),
            id: g.total_attempts,
            sender: p.wallet,
            msg_hash,
            fee_paid: fee,
            new_fee: g.current_fee,
            pot: g.pot,
        });
        Ok(())
    }

    // ─── Agent ───────────────────────────────────────────────────────────────

    /// Pay the whole pot to `winner`, the sender of `attempt_id`. Open until `end_time + GRACE`.
    pub fn release(ctx: Context<Release>, attempt_id: u64) -> Result<()> {
        let g = &mut ctx.accounts.game;
        require!(attempt_id >= 1 && attempt_id <= g.total_attempts, ClaudetteError::InvalidAttempt);
        require!(!g.won, ClaudetteError::GameWon);
        require!(!g.finalized, ClaudetteError::GameFinalized);
        let now = Clock::get()?.unix_timestamp;
        require!(now < g.end_time + GRACE, ClaudetteError::JudgingClosed);

        g.won = true;
        g.done_at = now;
        let amount = g.pot;
        g.pot = 0;
        g.sub_lamports(amount)?;
        ctx.accounts.winner.add_lamports(amount)?;

        emit!(Won { game: g.key(), id: attempt_id, winner: ctx.accounts.winner.key(), amount });
        Ok(())
    }

    // ─── No winner ───────────────────────────────────────────────────────────

    /// Close a game nobody won. Snapshots shares; rounding dust goes to treasury.
    pub fn finalize(ctx: Context<Finalize>) -> Result<()> {
        let g = &mut ctx.accounts.game;
        require!(!g.won, ClaudetteError::GameWon);
        require!(!g.finalized, ClaudetteError::GameFinalized);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= g.end_time + GRACE, ClaudetteError::GameNotOver);

        g.finalized = true;
        g.done_at = now;
        let p = g.pot;
        g.pot = 0;
        g.final_pot = p;

        let n = g.total_attempts;
        let (bonus, share) = if n > 0 {
            let bonus = p * LAST_PLAYER_BONUS_PCT / 100;
            (bonus, (p - bonus) / n)
        } else {
            (0, 0)
        };
        let dust = p - bonus - share * n;
        g.last_player_bonus = bonus;
        g.per_attempt = share;
        g.unclaimed = p - dust;
        g.treasury_owed += dust;

        emit!(Finalized { pot: p, last_player: g.last_player, last_player_bonus: bonus, per_attempt: share, dust });
        Ok(())
    }

    /// Claim your share after `finalize`, within `CLAIM_WINDOW`. Closes your player account and
    /// returns its rent too.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let g = &mut ctx.accounts.game;
        require!(g.finalized, ClaudetteError::NotFinalized);
        require!(!g.swept, ClaudetteError::ClaimWindowClosed);
        require!(Clock::get()?.unix_timestamp < g.done_at + CLAIM_WINDOW, ClaudetteError::ClaimWindowClosed);

        let wallet = ctx.accounts.wallet.key();
        let mut amount = ctx.accounts.player.attempts * g.per_attempt;
        if wallet == g.last_player {
            amount += g.last_player_bonus;
        }
        g.unclaimed -= amount;
        g.sub_lamports(amount)?;
        ctx.accounts.wallet.add_lamports(amount)?;

        emit!(Claimed { account: wallet, amount });
        Ok(())
    }

    /// After the claim window, move unclaimed shares to the treasury. Callable by anyone.
    pub fn sweep(ctx: Context<Sweep>) -> Result<()> {
        let g = &mut ctx.accounts.game;
        require!(g.finalized, ClaudetteError::NotFinalized);
        require!(!g.swept, ClaudetteError::AlreadySwept);
        require!(Clock::get()?.unix_timestamp >= g.done_at + CLAIM_WINDOW, ClaudetteError::ClaimWindowOpen);

        g.swept = true;
        let amount = g.unclaimed;
        g.unclaimed = 0;
        g.treasury_owed += amount;
        emit!(Swept { amount });
        Ok(())
    }

    /// Recover your player-account rent once there is nothing left to claim (game won or swept).
    pub fn close_player(ctx: Context<ClosePlayer>) -> Result<()> {
        let g = &ctx.accounts.game;
        require!(g.won || g.swept, ClaudetteError::GameNotOver);
        Ok(())
    }

    // ─── Treasury ────────────────────────────────────────────────────────────

    /// Push accrued treasury funds to `treasury`. Callable by anyone.
    pub fn withdraw_treasury(ctx: Context<WithdrawTreasury>) -> Result<()> {
        let g = &mut ctx.accounts.game;
        let amount = g.treasury_owed;
        require!(amount > 0, ClaudetteError::NothingToWithdraw);
        g.treasury_owed = 0;
        g.sub_lamports(amount)?;
        ctx.accounts.treasury.add_lamports(amount)?;
        emit!(TreasuryWithdrawn { treasury: g.treasury, amount });
        Ok(())
    }

    // ─── Owner ───────────────────────────────────────────────────────────────

    /// Rotate the agent key.
    pub fn set_agent(ctx: Context<OwnerOnly>, new_agent: Pubkey) -> Result<()> {
        require!(new_agent != Pubkey::default(), ClaudetteError::ZeroAddress);
        let g = &mut ctx.accounts.game;
        emit!(AgentUpdated { previous_agent: g.agent, new_agent });
        g.agent = new_agent;
        Ok(())
    }

    /// Close a finished game once players have had `CLAIM_WINDOW` to recover their rent and the
    /// treasury is withdrawn. Remaining lamports (rent) go to the treasury.
    pub fn close_game(ctx: Context<CloseGame>) -> Result<()> {
        let g = &ctx.accounts.game;
        require!(g.won || g.swept, ClaudetteError::GameNotOver);
        require!(g.treasury_owed == 0, ClaudetteError::TreasuryNotWithdrawn);
        require!(Clock::get()?.unix_timestamp >= g.done_at + CLAIM_WINDOW, ClaudetteError::ClaimWindowOpen);
        Ok(())
    }
}

// ─── Accounts ────────────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct Game {
    pub game_id: u64,
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub treasury: Pubkey,
    pub max_fee: u64,
    pub end_time: i64,
    /// Fee for the next attempt, in lamports.
    pub current_fee: u64,
    /// Lamports currently up for grabs. Zeroed on win or finalize.
    pub pot: u64,
    /// Treasury cut not yet withdrawn.
    pub treasury_owed: u64,
    pub total_attempts: u64,
    pub last_player: Pubkey,
    pub won: bool,
    pub finalized: bool,
    pub swept: bool,
    /// When the game was won or finalized.
    pub done_at: i64,
    // Finalize snapshot.
    pub final_pot: u64,
    pub last_player_bonus: u64,
    pub per_attempt: u64,
    /// Finalize payouts not yet claimed.
    pub unclaimed: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Player {
    pub game: Pubkey,
    pub wallet: Pubkey,
    pub attempts: u64,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + Game::INIT_SPACE, seeds = [GAME_SEED, &game_id.to_le_bytes()], bump)]
    pub game: Account<'info, Game>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitAttempt<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,
    #[account(mut, seeds = [GAME_SEED, &game.game_id.to_le_bytes()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(
        init_if_needed,
        payer = sender,
        space = 8 + Player::INIT_SPACE,
        seeds = [PLAYER_SEED, game.key().as_ref(), sender.key().as_ref()],
        bump
    )]
    pub player: Account<'info, Player>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    #[account(address = game.agent @ ClaudetteError::NotAgent)]
    pub agent: Signer<'info>,
    #[account(mut, seeds = [GAME_SEED, &game.game_id.to_le_bytes()], bump = game.bump)]
    pub game: Account<'info, Game>,
    /// CHECK: receives lamports only; bound to `winner_player` by its seeds.
    #[account(mut)]
    pub winner: UncheckedAccount<'info>,
    /// Must have played this game.
    #[account(
        seeds = [PLAYER_SEED, game.key().as_ref(), winner.key().as_ref()],
        bump = winner_player.bump,
    )]
    pub winner_player: Account<'info, Player>,
}

#[derive(Accounts)]
pub struct Finalize<'info> {
    #[account(mut, seeds = [GAME_SEED, &game.game_id.to_le_bytes()], bump = game.bump)]
    pub game: Account<'info, Game>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(mut, seeds = [GAME_SEED, &game.game_id.to_le_bytes()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(
        mut,
        close = wallet,
        seeds = [PLAYER_SEED, game.key().as_ref(), wallet.key().as_ref()],
        bump = player.bump,
    )]
    pub player: Account<'info, Player>,
}

#[derive(Accounts)]
pub struct Sweep<'info> {
    #[account(mut, seeds = [GAME_SEED, &game.game_id.to_le_bytes()], bump = game.bump)]
    pub game: Account<'info, Game>,
}

#[derive(Accounts)]
pub struct ClosePlayer<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(seeds = [GAME_SEED, &game.game_id.to_le_bytes()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(
        mut,
        close = wallet,
        seeds = [PLAYER_SEED, game.key().as_ref(), wallet.key().as_ref()],
        bump = player.bump,
    )]
    pub player: Account<'info, Player>,
}

#[derive(Accounts)]
pub struct WithdrawTreasury<'info> {
    #[account(mut, seeds = [GAME_SEED, &game.game_id.to_le_bytes()], bump = game.bump)]
    pub game: Account<'info, Game>,
    /// CHECK: receives lamports only; must be the configured treasury.
    #[account(mut, address = game.treasury @ ClaudetteError::WrongTreasury)]
    pub treasury: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    #[account(address = game.owner @ ClaudetteError::NotOwner)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [GAME_SEED, &game.game_id.to_le_bytes()], bump = game.bump)]
    pub game: Account<'info, Game>,
}

#[derive(Accounts)]
pub struct CloseGame<'info> {
    #[account(address = game.owner @ ClaudetteError::NotOwner)]
    pub owner: Signer<'info>,
    #[account(mut, close = treasury, seeds = [GAME_SEED, &game.game_id.to_le_bytes()], bump = game.bump)]
    pub game: Account<'info, Game>,
    /// CHECK: receives lamports only; must be the configured treasury.
    #[account(mut, address = game.treasury @ ClaudetteError::WrongTreasury)]
    pub treasury: UncheckedAccount<'info>,
}

// ─── Events ──────────────────────────────────────────────────────────────────

#[event]
pub struct AttemptSubmitted {
    pub game: Pubkey,
    pub id: u64,
    pub sender: Pubkey,
    pub msg_hash: [u8; 32],
    pub fee_paid: u64,
    pub new_fee: u64,
    pub pot: u64,
}

#[event]
pub struct Won {
    pub game: Pubkey,
    pub id: u64,
    pub winner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Finalized {
    pub pot: u64,
    pub last_player: Pubkey,
    pub last_player_bonus: u64,
    pub per_attempt: u64,
    pub dust: u64,
}

#[event]
pub struct Claimed {
    pub account: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Swept {
    pub amount: u64,
}

#[event]
pub struct TreasuryWithdrawn {
    pub treasury: Pubkey,
    pub amount: u64,
}

#[event]
pub struct AgentUpdated {
    pub previous_agent: Pubkey,
    pub new_agent: Pubkey,
}

#[error_code]
pub enum ClaudetteError {
    #[msg("zero address")]
    ZeroAddress,
    #[msg("invalid config")]
    InvalidConfig,
    #[msg("not the agent")]
    NotAgent,
    #[msg("not the owner")]
    NotOwner,
    #[msg("game already won")]
    GameWon,
    #[msg("game already finalized")]
    GameFinalized,
    #[msg("attempts are closed")]
    GameEnded,
    #[msg("game is not over")]
    GameNotOver,
    #[msg("judging window closed")]
    JudgingClosed,
    #[msg("fee rose above max_fee_willing")]
    FeeTooHigh,
    #[msg("invalid attempt id")]
    InvalidAttempt,
    #[msg("game not finalized")]
    NotFinalized,
    #[msg("claim window closed")]
    ClaimWindowClosed,
    #[msg("claim window still open")]
    ClaimWindowOpen,
    #[msg("already swept")]
    AlreadySwept,
    #[msg("nothing to withdraw")]
    NothingToWithdraw,
    #[msg("treasury not withdrawn")]
    TreasuryNotWithdrawn,
    #[msg("wrong treasury account")]
    WrongTreasury,
}
