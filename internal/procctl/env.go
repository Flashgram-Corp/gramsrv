// Package procctl 提供管理 web 面板「Environment (.env)」编辑器所需的 .env 解析
// 与改写能力。它只做本仓库需要的子集：从 .env.example 读取可编辑字段分组
// （ReadEnvGroups），把面板保存的值回写进 .env（WriteEnvValues）——不含进程管理
// （启动/停止/重启/更新）、PID 状态文件、git 操作与 docker 探测等更重的功能。
//
// 约定与脚本/面板一致：.env.example 用 `## 标题 -- 说明` 行切分组、`# ====...`
// 行断区间、`#` 注释段紧跟字段作为其描述，`TELESRV_*` 字段行可激活（`K=V`）或
// 注释掉（`# K=V`）。写回的基石是「以 .env.example 为底本、原位替换已知键的值」，
// 这样注释、布局与未触及的键都原样保留——绝不重新 dump 键值对。
package procctl

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	activeFieldRe    = regexp.MustCompile(`^(TELESRV_[A-Z0-9_]+)=(.*)$`)
	commentedFieldRe = regexp.MustCompile(`^#\s*(TELESRV_[A-Z0-9_]+)=(.*)$`)
	sensitiveKeyRe   = regexp.MustCompile(`(PASSWORD|SECRET|_TOKEN|API_KEY)`)
	// sensitiveKeyExceptRe 排除敏感词匹配里的 "SECRET" 命中但其实指的是 Telegram
	// 私密聊天功能、而非凭据的键（如 TELESRV_SECRET_CHAT_DELETE_FILE_AFTER_DOWNLOAD）：
	// 那里没有可掩码的内容，只是普通布尔开关。
	sensitiveKeyExceptRe = regexp.MustCompile(`SECRET_CHAT`)
	groupHeaderRe        = regexp.MustCompile(`^##\s*(.+?)\s*--\s*(.+)$`)
	sectionBreakRe       = regexp.MustCompile(`^#\s*={10,}\s*$`)
)

// EnvField 是单个可编辑环境变量在面板中的呈现：默认值、说明、是否默认启用、是否敏感
// （值应在 UI 掩码显示），以及当前生效值。
type EnvField struct {
	Key              string `json:"key"`
	DefaultValue     string `json:"default_value"`
	Description      string `json:"description"`
	EnabledByDefault bool   `json:"enabled_by_default"`
	Sensitive        bool   `json:"sensitive"`
	// Value 是字段的当前生效值：.env 有设置则取 .env，否则是该字段默认值
	// （仅当 EnabledByDefault 时），再否则为空。
	Value string `json:"value"`
}

// EnvGroup 是一个字段分组，对应 .env.example 中的一段 `## 标题 -- 说明`。
type EnvGroup struct {
	Title       string     `json:"title"`
	Description string     `json:"description"`
	Fields      []EnvField `json:"fields"`
}

// Manager 基于仓库根目录（Root）下的 .env 与 .env.example 工作。
type Manager struct {
	Root string
}

func NewManager(root string) *Manager {
	return &Manager{Root: root}
}

// ReadEnvGroups 把 .env.example 解析成面板可见的分组（header/格式规则见
// server-panel.py 的 parse_env_template()，两者一致），再用 .env 的当前值回填每个
// 字段的生效值。模板文件不存在时返回空分组（不报错）。
func (m *Manager) ReadEnvGroups() ([]EnvGroup, error) {
	tmplPath := filepath.Join(m.Root, ".env.example")
	tmplData, err := os.ReadFile(tmplPath)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read .env.example: %w", err)
	}
	envValues, err := m.readEnvFile()
	if err != nil {
		return nil, err
	}

	var groups []EnvGroup
	var current *EnvGroup
	var pending []string
	inCommentRun := false
	seen := map[string]bool{}

	appendField := func(key, defaultValue, description string, enabledByDefault bool) {
		if current == nil || seen[key] {
			return
		}
		seen[key] = true
		value, has := envValues[key]
		if !has {
			if enabledByDefault {
				value = defaultValue
			} else {
				value = ""
			}
		}
		current.Fields = append(current.Fields, EnvField{
			Key:              key,
			DefaultValue:     defaultValue,
			Description:      description,
			EnabledByDefault: enabledByDefault,
			Sensitive:        sensitiveKeyRe.MatchString(key) && !sensitiveKeyExceptRe.MatchString(key),
			Value:            value,
		})
	}

	for _, raw := range strings.Split(string(tmplData), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			pending = nil
			inCommentRun = false
			continue
		}
		if h := groupHeaderRe.FindStringSubmatch(line); h != nil {
			groups = append(groups, EnvGroup{Title: strings.TrimSpace(h[1]), Description: strings.TrimSpace(h[2])})
			current = &groups[len(groups)-1]
			pending = nil
			inCommentRun = false
			continue
		}
		if sectionBreakRe.MatchString(line) {
			current = nil
			pending = nil
			inCommentRun = false
			continue
		}
		if a := activeFieldRe.FindStringSubmatch(line); a != nil {
			appendField(a[1], a[2], strings.Join(pending, " "), true)
			inCommentRun = false
			continue
		}
		if strings.HasPrefix(line, "#") {
			if c := commentedFieldRe.FindStringSubmatch(line); c != nil {
				appendField(c[1], c[2], strings.Join(pending, " "), false)
				inCommentRun = false
				continue
			}
			text := strings.TrimSpace(strings.TrimLeft(line, "#"))
			if inCommentRun {
				pending = append(pending, text)
			} else {
				pending = []string{text}
			}
			inCommentRun = true
			continue
		}
		inCommentRun = false
	}

	out := groups[:0]
	for _, g := range groups {
		if len(g.Fields) > 0 {
			out = append(out, g)
		}
	}
	return out, nil
}

func (m *Manager) readEnvFile() (map[string]string, error) {
	values := map[string]string{}
	data, err := os.ReadFile(filepath.Join(m.Root, ".env"))
	if os.IsNotExist(err) {
		return values, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read .env: %w", err)
	}
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		idx := strings.IndexByte(line, '=')
		if idx <= 0 {
			continue
		}
		values[line[:idx]] = strings.TrimSpace(line[idx+1:])
	}
	return values, nil
}

// WriteEnvValues 以 .env.example 的原文为底本、原位替换每个已知键的值后回写 .env——
// 这样注释与布局原样保留。只有出现在 values 里的键才被改写；其余键一律保持当前
// .env 的值（.env 从未设置过的键才落到模板自身默认值）——早前版本曾对任何不在本次
// 保存载荷里的键直接回退到模板默认，使每次只改一个分组的保存都把其他已定制的设置
// （如 TELESRV_ADMIN_UI_PASSWORD）静默清掉。模板里注释掉的可选字段：给出非空值则
// 取消注释并写入，给出空值则原样保留注释行。
func (m *Manager) WriteEnvValues(values map[string]string) error {
	tmplPath := filepath.Join(m.Root, ".env.example")
	tmplData, err := os.ReadFile(tmplPath)
	if err != nil {
		return fmt.Errorf("read .env.example: %w", err)
	}
	existing, err := m.readEnvFile()
	if err != nil {
		return err
	}
	lines := strings.Split(string(tmplData), "\n")
	// Split() 对末尾 "\n" 会留下一个空尾元素；砍掉它，避免下面拼接时在尾部多加
	// 一行空行（本函数末尾本来就会补一个换行）。
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	out := make([]string, 0, len(lines))
	seen := map[string]bool{}
	for _, raw := range lines {
		line := strings.TrimSpace(raw)
		if a := activeFieldRe.FindStringSubmatch(line); a != nil && !seen[a[1]] {
			if v, ok := values[a[1]]; ok {
				seen[a[1]] = true
				out = append(out, a[1]+"="+v)
				continue
			}
			if v, ok := existing[a[1]]; ok {
				seen[a[1]] = true
				out = append(out, a[1]+"="+v)
				continue
			}
		}
		if c := commentedFieldRe.FindStringSubmatch(line); c != nil && !seen[c[1]] {
			if v, ok := values[c[1]]; ok {
				seen[c[1]] = true
				if v != "" {
					out = append(out, c[1]+"="+v)
				} else {
					out = append(out, raw)
				}
				continue
			}
			// 之前已启用的可选字段：模板里仍是注释行，但当前 .env 已有激活行——
			// 保持启用并沿用其现值。
			if v, ok := existing[c[1]]; ok {
				seen[c[1]] = true
				out = append(out, c[1]+"="+v)
				continue
			}
		}
		out = append(out, raw)
	}
	return os.WriteFile(filepath.Join(m.Root, ".env"), []byte(strings.Join(out, "\n")+"\n"), 0o644)
}
