use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    ffi::OsString,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

const MAX_SCENE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_RECENT_FILES: usize = 10;

#[derive(Default)]
pub struct DesktopState {
    pending_paths: Mutex<VecDeque<PathBuf>>,
    document_paths: Mutex<HashMap<String, PathBuf>>,
    recent_files: Mutex<Vec<RecentFileRecord>>,
    recent_store_path: Mutex<Option<PathBuf>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentFileRecord {
    id: String,
    file_name: String,
    path: PathBuf,
    last_opened_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentSceneEntry {
    id: String,
    file_name: String,
    path_label: String,
    last_opened_at: u64,
}

impl From<&RecentFileRecord> for RecentSceneEntry {
    fn from(record: &RecentFileRecord) -> Self {
        Self {
            id: record.id.clone(),
            file_name: record.file_name.clone(),
            path_label: record.path.to_string_lossy().into_owned(),
            last_opened_at: record.last_opened_at,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopOpenedScene {
    contents: String,
    file_name: String,
    token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSavedScene {
    file_name: String,
    token: String,
    sha256: String,
}

fn mutex_error(name: &str) -> String {
    format!("桌面状态 {name} 暂时不可用，请重启 Motion Studio。")
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn normalized_path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

fn recent_id(path: &Path) -> String {
    let digest = Sha256::digest(normalized_path_key(path).as_bytes());
    format!("{digest:x}")
}

pub(crate) fn is_supported_scene_path(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let normalized = file_name.trim().to_lowercase();
    normalized.ends_with(".motionstudio")
        || normalized.ends_with(".motion.json")
        || normalized.ends_with(".json")
}

fn validate_scene_path(path: &Path, must_exist: bool) -> Result<(), String> {
    if !is_supported_scene_path(path) {
        return Err("请选择 .motionstudio、.motion.json 或 .json 场景文件。".into());
    }
    if must_exist {
        let metadata =
            fs::metadata(path).map_err(|_| "场景文件不存在或当前账号没有读取权限。".to_string())?;
        if !metadata.is_file() {
            return Err("所选路径不是场景文件。".into());
        }
        if metadata.len() > MAX_SCENE_BYTES {
            return Err("场景文件超过 10 MB，已停止读取。".into());
        }
    }
    Ok(())
}

pub(crate) fn safe_scene_file_name(source: &str) -> String {
    let mut sanitized: String = source
        .chars()
        .filter(|character| !character.is_control())
        .map(|character| {
            if matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            ) {
                '-'
            } else {
                character
            }
        })
        .collect();
    sanitized = sanitized.trim().trim_end_matches(['.', ' ']).to_string();
    if sanitized.is_empty() {
        sanitized = "未命名场景".into();
    }
    let normalized = sanitized.to_lowercase();
    if !normalized.ends_with(".motionstudio")
        && !normalized.ends_with(".motion.json")
        && !normalized.ends_with(".json")
    {
        sanitized.push_str(".motionstudio");
    }
    sanitized
}

fn canonical_existing_path(path: &Path) -> Result<PathBuf, String> {
    path.canonicalize()
        .map_err(|_| "无法解析场景文件路径。".to_string())
}

fn read_scene_path(path: &Path, state: &DesktopState) -> Result<DesktopOpenedScene, String> {
    validate_scene_path(path, true)?;
    let canonical = canonical_existing_path(path)?;
    let contents = fs::read_to_string(&canonical)
        .map_err(|_| "无法以 UTF-8 文本读取该场景文件。".to_string())?;
    if contents.len() as u64 > MAX_SCENE_BYTES {
        return Err("场景文件超过 10 MB，已停止读取。".into());
    }

    let token = Uuid::new_v4().to_string();
    state
        .document_paths
        .lock()
        .map_err(|_| mutex_error("文档令牌"))?
        .insert(token.clone(), canonical.clone());

    Ok(DesktopOpenedScene {
        contents,
        file_name: canonical
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "未命名场景.motionstudio".into()),
        token,
    })
}

fn persist_recent_files(state: &DesktopState) -> Result<(), String> {
    let store_path = state
        .recent_store_path
        .lock()
        .map_err(|_| mutex_error("最近文件路径"))?
        .clone();
    let Some(store_path) = store_path else {
        return Ok(());
    };
    let records = state
        .recent_files
        .lock()
        .map_err(|_| mutex_error("最近文件"))?
        .clone();
    if let Some(parent) = store_path.parent() {
        fs::create_dir_all(parent).map_err(|_| "无法创建桌面设置目录。".to_string())?;
    }
    let payload =
        serde_json::to_vec_pretty(&records).map_err(|_| "无法序列化最近文件。".to_string())?;
    fs::write(store_path, payload).map_err(|_| "无法保存最近文件列表。".to_string())
}

fn upsert_recent(state: &DesktopState, path: &Path) -> Result<(), String> {
    let canonical = canonical_existing_path(path)?;
    let id = recent_id(&canonical);
    let file_name = canonical
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "未命名场景.motionstudio".into());
    {
        let mut records = state
            .recent_files
            .lock()
            .map_err(|_| mutex_error("最近文件"))?;
        records.retain(|record| record.id != id);
        records.insert(
            0,
            RecentFileRecord {
                id,
                file_name,
                path: canonical,
                last_opened_at: now_millis(),
            },
        );
        records.truncate(MAX_RECENT_FILES);
    }
    persist_recent_files(state)
}

fn remove_recent(state: &DesktopState, id: &str) -> Result<(), String> {
    state
        .recent_files
        .lock()
        .map_err(|_| mutex_error("最近文件"))?
        .retain(|record| record.id != id);
    persist_recent_files(state)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("{digest:x}")
}

pub(crate) fn write_verified_scene(path: &Path, contents: &str) -> Result<String, String> {
    validate_scene_path(path, false)?;
    if contents.len() as u64 > MAX_SCENE_BYTES {
        return Err("场景内容超过 10 MB，无法保存。".into());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| "无法创建场景文件所在目录。".to_string())?;
    }
    let mut file = fs::File::create(path).map_err(|_| "无法创建或覆盖场景文件。".to_string())?;
    file.write_all(contents.as_bytes())
        .map_err(|_| "写入场景文件失败。".to_string())?;
    file.sync_all()
        .map_err(|_| "场景文件已写入，但无法同步到磁盘。".to_string())?;
    let saved = fs::read(path).map_err(|_| "保存后无法重新读取场景文件。".to_string())?;
    let expected = sha256_hex(contents.as_bytes());
    let actual = sha256_hex(&saved);
    if actual != expected {
        return Err("保存后的内容校验失败，请使用“另存为”保留当前场景。".into());
    }
    Ok(actual)
}

pub fn initialize(app: &AppHandle, initial_args: impl IntoIterator<Item = OsString>) {
    let state = app.state::<DesktopState>();
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        let store_path = app_data_dir.join("recent-files.json");
        if let Ok(mut target) = state.recent_store_path.lock() {
            *target = Some(store_path.clone());
        }
        let loaded = fs::read(&store_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<RecentFileRecord>>(&bytes).ok())
            .unwrap_or_default();
        if let Ok(mut recent) = state.recent_files.lock() {
            *recent = loaded.into_iter().take(MAX_RECENT_FILES).collect();
        }
    }
    queue_arguments(&state, initial_args);
}

pub fn queue_arguments(
    state: &DesktopState,
    arguments: impl IntoIterator<Item = OsString>,
) -> bool {
    let candidates: Vec<PathBuf> = arguments
        .into_iter()
        .map(PathBuf::from)
        .filter(|path| is_supported_scene_path(path) && path.is_file())
        .collect();
    if candidates.is_empty() {
        return false;
    }
    if let Ok(mut pending) = state.pending_paths.lock() {
        for path in candidates {
            if !pending.iter().any(|queued| {
                normalized_path_key(queued.as_path()) == normalized_path_key(path.as_path())
            }) {
                pending.push_back(path);
            }
        }
        return true;
    }
    false
}

#[tauri::command]
pub async fn desktop_open_scene(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Option<DesktopOpenedScene>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("打开 Motion Studio 场景")
        .add_filter("Motion Studio 场景", &["motionstudio", "json"])
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|_| "系统文件选择器没有返回本地路径。".to_string())?;
    read_scene_path(&path, &state).map(Some)
}

#[tauri::command]
pub async fn desktop_take_pending_scene(
    state: State<'_, DesktopState>,
) -> Result<Option<DesktopOpenedScene>, String> {
    let path = state
        .pending_paths
        .lock()
        .map_err(|_| mutex_error("待打开文件"))?
        .pop_front();
    match path {
        Some(path) => read_scene_path(&path, &state).map(Some),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn desktop_confirm_scene_opened(
    token: String,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    let path = state
        .document_paths
        .lock()
        .map_err(|_| mutex_error("文档令牌"))?
        .get(&token)
        .cloned()
        .ok_or_else(|| "该文档令牌已失效，请重新打开文件。".to_string())?;
    upsert_recent(&state, &path)
}

#[tauri::command]
pub async fn desktop_save_scene(
    app: AppHandle,
    existing_token: Option<String>,
    save_as: bool,
    suggested_name: String,
    contents: String,
    state: State<'_, DesktopState>,
) -> Result<Option<DesktopSavedScene>, String> {
    let existing_path = if save_as {
        None
    } else {
        existing_token
            .as_ref()
            .and_then(|token| state.document_paths.lock().ok()?.get(token).cloned())
    };
    let path = match existing_path {
        Some(path) => path,
        None => {
            let selected = app
                .dialog()
                .file()
                .set_title("保存 Motion Studio 场景")
                .set_file_name(safe_scene_file_name(&suggested_name))
                .add_filter("Motion Studio 场景", &["motionstudio"])
                .blocking_save_file();
            let Some(selected) = selected else {
                return Ok(None);
            };
            selected
                .into_path()
                .map_err(|_| "系统文件选择器没有返回本地路径。".to_string())?
        }
    };
    let path = if path.extension().is_none() {
        path.with_extension("motionstudio")
    } else {
        path
    };
    let sha256 = write_verified_scene(&path, &contents)?;
    let canonical = canonical_existing_path(&path)?;
    let token = existing_token.unwrap_or_else(|| Uuid::new_v4().to_string());
    state
        .document_paths
        .lock()
        .map_err(|_| mutex_error("文档令牌"))?
        .insert(token.clone(), canonical.clone());
    upsert_recent(&state, &canonical)?;

    Ok(Some(DesktopSavedScene {
        file_name: canonical
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "未命名场景.motionstudio".into()),
        token,
        sha256,
    }))
}

#[tauri::command]
pub fn desktop_list_recent_scenes(
    state: State<'_, DesktopState>,
) -> Result<Vec<RecentSceneEntry>, String> {
    Ok(state
        .recent_files
        .lock()
        .map_err(|_| mutex_error("最近文件"))?
        .iter()
        .map(RecentSceneEntry::from)
        .collect())
}

#[tauri::command]
pub fn desktop_open_recent_scene(
    id: String,
    state: State<'_, DesktopState>,
) -> Result<DesktopOpenedScene, String> {
    let path = state
        .recent_files
        .lock()
        .map_err(|_| mutex_error("最近文件"))?
        .iter()
        .find(|record| record.id == id)
        .map(|record| record.path.clone())
        .ok_or_else(|| "最近文件记录不存在。".to_string())?;
    match read_scene_path(&path, &state) {
        Ok(scene) => Ok(scene),
        Err(error) => {
            let _ = remove_recent(&state, &id);
            Err(format!("{error} 已从最近文件中移除。"))
        }
    }
}

#[tauri::command]
pub fn desktop_remove_recent_scene(
    id: String,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    remove_recent(&state, &id)
}

#[tauri::command]
pub fn desktop_clear_recent_scenes(state: State<'_, DesktopState>) -> Result<(), String> {
    state
        .recent_files
        .lock()
        .map_err(|_| mutex_error("最近文件"))?
        .clear();
    persist_recent_files(&state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_current_and_legacy_scene_extensions() {
        assert!(is_supported_scene_path(Path::new("实验.motionstudio")));
        assert!(is_supported_scene_path(Path::new("实验.motion.json")));
        assert!(is_supported_scene_path(Path::new("实验.JSON")));
        assert!(!is_supported_scene_path(Path::new("实验.txt")));
        assert!(!is_supported_scene_path(Path::new("实验.motionstudio.exe")));
    }

    #[test]
    fn sanitizes_windows_file_names_and_adds_extension() {
        assert_eq!(
            safe_scene_file_name("  弹簧:实验?  "),
            "弹簧-实验-.motionstudio"
        );
        assert_eq!(safe_scene_file_name("保留.motion.json"), "保留.motion.json");
        assert_eq!(safe_scene_file_name("..."), "未命名场景.motionstudio");
    }

    #[test]
    fn writes_and_verifies_unicode_scene_path() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("含 空格的场景.motionstudio");
        let contents = "{\"schemaVersion\":7}\n";
        let digest = write_verified_scene(&path, contents).expect("write scene");
        assert_eq!(digest, sha256_hex(contents.as_bytes()));
        assert_eq!(fs::read_to_string(path).expect("read scene"), contents);
    }

    #[test]
    fn rejects_unsupported_output_extension() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("secret.txt");
        assert!(write_verified_scene(&path, "{}").is_err());
        assert!(!path.exists());
    }

    #[test]
    fn rejects_scene_content_over_limit() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("too-large.motionstudio");
        let contents = "x".repeat(MAX_SCENE_BYTES as usize + 1);
        assert!(write_verified_scene(&path, &contents).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn rejects_oversized_scene_before_reading_it() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("too-large.motionstudio");
        fs::write(&path, vec![b'x'; MAX_SCENE_BYTES as usize + 1]).expect("write test file");
        assert!(validate_scene_path(&path, true).is_err());
        assert!(read_scene_path(&path, &DesktopState::default()).is_err());
    }

    #[test]
    fn opened_paths_are_only_available_through_opaque_tokens() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("授权 场景.motionstudio");
        fs::write(&path, "{\"schemaVersion\":7}\n").expect("write scene");
        let canonical = path.canonicalize().expect("canonical path");
        let state = DesktopState::default();

        let opened = read_scene_path(&path, &state).expect("open scene");
        assert_eq!(opened.contents, "{\"schemaVersion\":7}\n");
        assert_eq!(opened.file_name, "授权 场景.motionstudio");
        assert_ne!(opened.token, canonical.to_string_lossy());

        let authorized = state.document_paths.lock().expect("document paths");
        assert_eq!(authorized.len(), 1);
        assert_eq!(authorized.get(&opened.token), Some(&canonical));
        assert!(!authorized.contains_key(canonical.to_string_lossy().as_ref()));
        assert!(!authorized.contains_key("C:/未授权/任意场景.motionstudio"));
    }

    #[test]
    fn queues_only_unique_supported_file_arguments() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let first = directory.path().join("首次 启动.motionstudio");
        let second = directory.path().join("第二实例.motion.json");
        let unsupported = directory.path().join("忽略.txt");
        fs::write(&first, "{}").expect("write first scene");
        fs::write(&second, "{}").expect("write second scene");
        fs::write(&unsupported, "{}").expect("write unsupported file");
        let state = DesktopState::default();

        assert!(queue_arguments(
            &state,
            [
                OsString::from("physics-motion-studio.exe"),
                first.as_os_str().to_owned(),
                first.as_os_str().to_owned(),
                second.as_os_str().to_owned(),
                unsupported.as_os_str().to_owned(),
                directory.path().as_os_str().to_owned(),
            ],
        ));

        let pending = state.pending_paths.lock().expect("pending paths");
        assert_eq!(pending.len(), 2);
        assert_eq!(pending.front(), Some(&first));
        assert_eq!(pending.back(), Some(&second));
    }

    #[test]
    fn rejects_arguments_without_a_valid_scene_file() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let state = DesktopState::default();
        assert!(!queue_arguments(
            &state,
            [
                OsString::from("physics-motion-studio.exe"),
                directory.path().as_os_str().to_owned(),
                directory
                    .path()
                    .join("missing.motionstudio")
                    .as_os_str()
                    .to_owned(),
            ],
        ));
        assert!(state
            .pending_paths
            .lock()
            .expect("pending paths")
            .is_empty());
    }

    #[test]
    fn persists_recent_files_in_latest_first_order_with_a_ten_item_limit() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let store_path = directory.path().join("settings/recent-files.json");
        let state = DesktopState::default();
        *state.recent_store_path.lock().expect("recent store path") = Some(store_path.clone());

        let mut paths = Vec::new();
        for index in 0..12 {
            let path = directory.path().join(format!("场景 {index}.motionstudio"));
            fs::write(&path, "{}").expect("write scene");
            upsert_recent(&state, &path).expect("upsert recent");
            paths.push(path.canonicalize().expect("canonical path"));
        }

        {
            let recent = state.recent_files.lock().expect("recent files");
            assert_eq!(recent.len(), MAX_RECENT_FILES);
            assert_eq!(recent[0].path, paths[11]);
            assert_eq!(recent[9].path, paths[2]);
        }

        upsert_recent(&state, &paths[5]).expect("move existing recent to front");
        {
            let recent = state.recent_files.lock().expect("recent files");
            assert_eq!(recent.len(), MAX_RECENT_FILES);
            assert_eq!(recent[0].path, paths[5]);
            assert_eq!(
                recent
                    .iter()
                    .filter(|record| record.path == paths[5])
                    .count(),
                1
            );
        }

        let persisted: Vec<RecentFileRecord> =
            serde_json::from_slice(&fs::read(store_path).expect("read recent store"))
                .expect("parse recent store");
        assert_eq!(persisted.len(), MAX_RECENT_FILES);
        assert_eq!(persisted[0].path, paths[5]);
    }
}
