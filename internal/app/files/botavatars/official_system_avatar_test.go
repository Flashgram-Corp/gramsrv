package botavatars

import (
	"context"
	"testing"

	"telesrv/internal/domain"
)

// recordingAvatarSetter is a minimal AvatarSetter that records the bytes of
// every created photo and lets the current photo be replaced, matching the
// real media store (AddProfilePhotoKind appends a newer active row).
type recordingAvatarSetter struct {
	current map[int64]int64
	created map[int64][]byte
	nextID  int64
}

func newRecordingAvatarSetter() *recordingAvatarSetter {
	return &recordingAvatarSetter{
		current: make(map[int64]int64),
		created: make(map[int64][]byte),
	}
}

func (f *recordingAvatarSetter) CurrentProfilePhotoKind(_ context.Context, _ domain.PeerType, peerID int64, _ domain.ProfilePhotoKind) (domain.Photo, bool, error) {
	id, ok := f.current[peerID]
	return domain.Photo{ID: id}, ok, nil
}

func (f *recordingAvatarSetter) CreateAvatarFromBytes(_ context.Context, data []byte) (domain.Photo, error) {
	f.nextID++
	f.created[f.nextID] = append([]byte(nil), data...)
	return domain.Photo{ID: f.nextID}, nil
}

func (f *recordingAvatarSetter) CreateAvatarVideoFromBytes(_ context.Context, _ []byte, _ float64) (domain.Photo, error) {
	return domain.Photo{}, nil
}

func (f *recordingAvatarSetter) SetCurrentProfilePhotoKind(_ context.Context, _ domain.PeerType, peerID int64, _ domain.ProfilePhotoKind, photoID int64, _ int) (domain.Photo, bool, error) {
	f.current[peerID] = photoID
	return domain.Photo{ID: photoID}, true, nil
}

func (f *recordingAvatarSetter) SeedTx(ctx context.Context, fn func(ctx context.Context, tx AvatarSetter) error) error {
	return fn(ctx, f)
}

func TestSeedOfficialSystemAvatarUsesCustomIcon(t *testing.T) {
	av := newRecordingAvatarSetter()
	custom := []byte("operator-icon")

	usingCustom, err := SeedOfficialSystemAvatar(context.Background(), av, custom, 1000)
	if err != nil {
		t.Fatalf("SeedOfficialSystemAvatar: %v", err)
	}
	if !usingCustom {
		t.Fatal("expected usingCustom=true with a non-empty icon")
	}
	photoID, ok := av.current[domain.OfficialSystemUserID]
	if !ok || photoID == 0 {
		t.Fatalf("official system account has no avatar: %+v", av.current)
	}
	if got := av.created[photoID]; string(got) != string(custom) {
		t.Fatalf("avatar bytes = %q, want the custom icon %q", got, custom)
	}
}

func TestSeedOfficialSystemAvatarReplacesExistingWithCustomIcon(t *testing.T) {
	av := newRecordingAvatarSetter()
	av.current[domain.OfficialSystemUserID] = 99
	av.created[99] = []byte("previous")
	custom := []byte("new-operator-icon")

	if _, err := SeedOfficialSystemAvatar(context.Background(), av, custom, 1000); err != nil {
		t.Fatalf("SeedOfficialSystemAvatar: %v", err)
	}
	photoID := av.current[domain.OfficialSystemUserID]
	if photoID == 99 {
		t.Fatal("custom icon did not replace the existing avatar")
	}
	if got := av.created[photoID]; string(got) != string(custom) {
		t.Fatalf("avatar bytes = %q, want the custom icon %q", got, custom)
	}
}

func TestSeedOfficialSystemAvatarSeedsDefaultWithoutCustomIcon(t *testing.T) {
	av := newRecordingAvatarSetter()

	usingCustom, err := SeedOfficialSystemAvatar(context.Background(), av, nil, 1000)
	if err != nil {
		t.Fatalf("SeedOfficialSystemAvatar: %v", err)
	}
	if usingCustom {
		t.Fatal("expected usingCustom=false without a custom icon")
	}
	first := av.current[domain.OfficialSystemUserID]
	if first == 0 {
		t.Fatal("default avatar was not seeded for the official system account")
	}
	if len(av.created[first]) == 0 {
		t.Fatal("default avatar bytes are empty")
	}
}

func TestSeedOfficialSystemAvatarRevertsToDefaultOnIconRemoval(t *testing.T) {
	av := newRecordingAvatarSetter()
	av.current[domain.OfficialSystemUserID] = 99
	av.created[99] = []byte("previous-custom")

	// Removing the operator icon (nil) must replace the custom avatar with the
	// bundled default rather than leave the stale custom one in place.
	usingCustom, err := SeedOfficialSystemAvatar(context.Background(), av, nil, 2000)
	if err != nil {
		t.Fatalf("SeedOfficialSystemAvatar: %v", err)
	}
	if usingCustom {
		t.Fatal("expected usingCustom=false without a custom icon")
	}
	photoID := av.current[domain.OfficialSystemUserID]
	if photoID == 99 {
		t.Fatal("removing the custom icon did not replace the existing avatar")
	}
	if len(av.created[photoID]) == 0 {
		t.Fatal("default avatar bytes are empty")
	}
}
