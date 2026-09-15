package postgres

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

// TestDialogReadModelBumpsTwoPeersOfSameOwnerConcurrently is the regression
// for migration 0206. The advisory lock inside telesrv_bump_dialog_light must
// be owner-scoped, not (owner, peer): the dialog_owner row is a single row
// shared by every peer of the owner, so two transactions that each bump two
// peers of the same owner in opposite order used to deadlock (Postgres 40P01)
// -- txn A held advisory(owner, A)+dialog_owner while txn B held
// advisory(owner, B) and waited for dialog_owner, then A waited for
// advisory(owner, B).
func TestDialogReadModelBumpsTwoPeersOfSameOwnerConcurrently(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()

	suffix := time.Now().UnixNano() % 1_000_000_000
	ownerID := int64(6_100_000_000) + suffix
	peerA := ownerID + 1001
	peerB := ownerID + 1002

	// Deterministic interleave:
	//   txn1 bumps peerA (holds the owner-scoped advisory lock and the
	//   dialog_owner row), then bumps peerB.
	//   txn2 starts only after txn1's first bump so it must take the same
	//   owner lock and bump peerB while txn1 is still uncommitted, then peerA.
	oneASeen := make(chan struct{}, 1)
	errCh := make(chan error, 2)

	bump := func(peerID int64) error {
		_, err := pool.Exec(ctx, `SELECT public.telesrv_bump_dialog_light($1, 'user', $2)`, ownerID, peerID)
		return err
	}

	go func() {
		tx, err := pool.Begin(ctx)
		if err != nil {
			errCh <- fmt.Errorf("txn1 begin: %w", err)
			return
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if err := bump(peerA); err != nil {
			errCh <- fmt.Errorf("txn1 bump A: %w", err)
			return
		}
		oneASeen <- struct{}{}
		if err := bump(peerB); err != nil {
			errCh <- fmt.Errorf("txn1 bump B: %w", err)
			return
		}
		if err := tx.Commit(ctx); err != nil {
			errCh <- fmt.Errorf("txn1 commit: %w", err)
			return
		}
		errCh <- nil
	}()

	go func() {
		<-oneASeen
		tx, err := pool.Begin(ctx)
		if err != nil {
			errCh <- fmt.Errorf("txn2 begin: %w", err)
			return
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if err := bump(peerB); err != nil {
			errCh <- fmt.Errorf("txn2 bump B: %w", err)
			return
		}
		if err := bump(peerA); err != nil {
			errCh <- fmt.Errorf("txn2 bump A: %w", err)
			return
		}
		if err := tx.Commit(ctx); err != nil {
			errCh <- fmt.Errorf("txn2 commit: %w", err)
			return
		}
		errCh <- nil
	}()

	timeout := time.NewTimer(20 * time.Second)
	defer timeout.Stop()
	var failures []error
	for i := 0; i < 2; i++ {
		select {
		case err := <-errCh:
			if err != nil {
				failures = append(failures, err)
			}
		case <-timeout.C:
			failures = append(failures, errors.New("concurrent dialog bumps timed out"))
		}
	}
	if len(failures) > 0 {
		for _, failure := range failures {
			t.Logf("failure: %v", failure)
		}
		t.Fatalf("concurrent dialog bumps for two peers of one owner failed, want both transactions to commit")
	}
}