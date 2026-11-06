use std::{env, fs, path::Path};
use zed::settings::LspSettings;
use zed_extension_api::{self as zed, LanguageServerId, Result};

const ALPINE_SERVER_ID: &str = "alpine";
const ALPINE_SERVER_PATH: &str = "alpine-language-server.js";
const ALPINE_SERVER_SOURCE: &str = include_str!("alpine-language-server.js");
const GOPLS_PROXY_PATH: &str = "gopls-templ-proxy.js";
const GOPLS_PROXY_SOURCE: &str = include_str!("gopls-templ-proxy.js");
const VERSION_DIR_PREFIX: &str = "templ-";

fn binary_name(platform: zed::Os) -> &'static str {
    match platform {
        zed::Os::Windows => "templ.exe",
        zed::Os::Mac | zed::Os::Linux => "templ",
    }
}

/// Finds the binary of an earlier download, for starts where GitHub cannot be reached.
fn downloaded_binary(directory: &Path, binary: &str) -> Option<String> {
    fs::read_dir(directory).ok()?.flatten().find_map(|entry| {
        let name = entry.file_name().into_string().ok()?;
        (name.starts_with(VERSION_DIR_PREFIX) && entry.path().join(binary).is_file())
            .then(|| format!("{name}/{binary}"))
    })
}

struct TemplExtension {
    cached_binary_path: Option<String>,
}

impl TemplExtension {
    /// Writes the optional gopls proxy for users to reference from `lsp.gopls.binary.path`.
    /// Zed starts it directly, so it must be executable.
    fn write_gopls_proxy(&self) -> Result<()> {
        fs::write(GOPLS_PROXY_PATH, GOPLS_PROXY_SOURCE)
            .map_err(|e| format!("failed to write {GOPLS_PROXY_PATH}: {e}"))?;
        zed::make_file_executable(GOPLS_PROXY_PATH)
    }

    /// Writes the embedded server on every start, so it always matches this build
    /// and survives the templ download's cleanup of the working directory.
    fn alpine_server_command(&self) -> Result<zed::Command> {
        fs::write(ALPINE_SERVER_PATH, ALPINE_SERVER_SOURCE)
            .map_err(|e| format!("failed to write {ALPINE_SERVER_PATH}: {e}"))?;
        let server_path = env::current_dir()
            .map_err(|e| format!("failed to read working directory: {e}"))?
            .join(ALPINE_SERVER_PATH);
        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![server_path.to_string_lossy().into_owned()],
            env: Default::default(),
        })
    }

    fn language_server_binary_path(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<String> {
        if let Some(path) = &self.cached_binary_path {
            if fs::metadata(path).map_or(false, |stat| stat.is_file()) {
                return Ok(path.clone());
            }
        }

        if let Some(path) = worktree.which("templ") {
            self.cached_binary_path = Some(path.clone());
            return Ok(path);
        }

        let (platform, arch) = zed::current_platform();
        let binary = binary_name(platform);

        zed::set_language_server_installation_status(
            &language_server_id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );
        let release = match zed::latest_github_release(
            "a-h/templ",
            zed::GithubReleaseOptions {
                require_assets: true,
                pre_release: false,
            },
        ) {
            Ok(release) => release,
            Err(error) => {
                let path = downloaded_binary(Path::new("."), binary).ok_or(error)?;
                self.cached_binary_path = Some(path.clone());
                return Ok(path);
            }
        };

        let asset_name = format!(
            "templ_{os}_{arch}.tar.gz",
            os = match platform {
                zed::Os::Mac => "Darwin",
                zed::Os::Linux => "Linux",
                zed::Os::Windows => "Windows",
            },
            arch = match arch {
                zed::Architecture::Aarch64 => "arm64",
                zed::Architecture::X86 => "i386",
                zed::Architecture::X8664 => "x86_64",
            }
        );

        let asset = release
            .assets
            .iter()
            .find(|asset| asset.name == asset_name)
            .ok_or_else(|| format!("no asset found matching {:?}", asset_name))?;

        let version_dir = format!("{VERSION_DIR_PREFIX}{}", release.version);
        let binary_path = format!("{version_dir}/{binary}");

        if !fs::metadata(&binary_path).map_or(false, |stat| stat.is_file()) {
            zed::set_language_server_installation_status(
                &language_server_id,
                &zed::LanguageServerInstallationStatus::Downloading,
            );

            zed::download_file(
                &asset.download_url,
                &version_dir,
                zed::DownloadedFileType::GzipTar,
            )
            .map_err(|e| format!("failed to download file: {e}"))?;

            let entries =
                fs::read_dir(".").map_err(|e| format!("failed to list working directory {e}"))?;
            for entry in entries {
                let entry = entry.map_err(|e| format!("failed to load directory entry {e}"))?;
                if entry.file_name().to_str() != Some(&version_dir) {
                    fs::remove_dir_all(&entry.path()).ok();
                }
            }
        }

        self.cached_binary_path = Some(binary_path.clone());
        Ok(binary_path)
    }
}

impl zed::Extension for TemplExtension {
    fn new() -> Self {
        Self {
            cached_binary_path: None,
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        if language_server_id.as_ref() == ALPINE_SERVER_ID {
            return self.alpine_server_command();
        }

        // Resolve the binary first, because its download cleans the working directory.
        let command = self.language_server_binary_path(language_server_id, worktree)?;
        self.write_gopls_proxy()?;

        Ok(zed::Command {
            command,
            args: vec!["lsp".to_string()],
            env: Default::default(),
        })
    }

    fn language_server_workspace_configuration(
        &mut self,
        server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        let settings = LspSettings::for_worktree(server_id.as_ref(), worktree)
            .ok()
            .and_then(|lsp_settings| lsp_settings.settings.clone())
            .unwrap_or_default();
        Ok(Some(settings))
    }
}

zed::register_extension!(TemplExtension);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downloaded_binary_finds_only_a_version_directory_with_the_binary() {
        let directory = env::temp_dir().join(format!("zed-templ-{}", std::process::id()));
        fs::create_dir_all(directory.join("templ-v1")).unwrap();
        fs::create_dir_all(directory.join("other")).unwrap();
        fs::write(directory.join("templ-v1/templ"), "").unwrap();
        fs::write(directory.join("other/templ.exe"), "").unwrap();

        let found = downloaded_binary(&directory, "templ");
        let missing = downloaded_binary(&directory, "templ.exe");
        fs::remove_dir_all(&directory).unwrap();

        assert_eq!(found.as_deref(), Some("templ-v1/templ"));
        assert_eq!(missing, None);
    }

    #[test]
    fn binary_name_has_the_windows_suffix() {
        assert_eq!(binary_name(zed::Os::Windows), "templ.exe");
        assert_eq!(binary_name(zed::Os::Linux), "templ");
    }
}
