use zed_extension_api as zed;

// Zed's wasm sandbox only sees extensions/work/<id>, which starts empty.
// The extension source tree is not mounted there, so the bundle has to travel
// inside the wasm and be written out before Node starts.
const SERVER_JS: &[u8] = include_bytes!("../server/dist/server.js");

struct DagonExtension;

impl DagonExtension {
    fn install_server(&self) -> Result<String, String> {
        let path = std::env::current_dir()
            .map_err(|err| format!("extension work dir: {err}"))?
            .join("server/dist/server.js");

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("create {}: {err}", parent.display()))?;
        }
        std::fs::write(&path, SERVER_JS)
            .map_err(|err| format!("write {}: {err}", path.display()))?;

        Ok(path.to_string_lossy().into_owned())
    }
}

impl zed::Extension for DagonExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<zed::Command, String> {
        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![self.install_server()?, "--stdio".to_string()],
            env: Default::default(),
        })
    }
}

zed::register_extension!(DagonExtension);
