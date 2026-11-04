use std::fs::{self, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub const LOG_BYTES: u64 = 1024 * 1024;
// Keep a working session of per-attempt Tableau diagnostics while retaining a
// fixed disk budget. Desktop lifecycle logs do not need the same capacity.
pub const SERVER_LOG_BYTES: u64 = 16 * 1024 * 1024;
pub const LOG_ARCHIVES: usize = 2;
const READ_BYTES: usize = 8192;

#[derive(Clone)]
pub struct BoundedLog(Arc<Mutex<LogFiles>>);

struct LogFiles {
    path: PathBuf,
    bytes: u64,
    archives: usize,
}

impl BoundedLog {
    pub fn open(path: PathBuf, bytes: u64, archives: usize) -> io::Result<Self> {
        if bytes == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Log capacity must be positive.",
            ));
        }
        let files = LogFiles {
            path,
            bytes,
            archives,
        };
        if let Some(parent) = files.path.parent() {
            fs::create_dir_all(parent)?;
        }
        // Bound logs left by older versions too, without loading them into memory.
        for index in 0..=archives {
            trim_tail(&files.at(index), bytes)?;
        }
        Ok(Self(Arc::new(Mutex::new(files))))
    }

    pub fn append(&self, mut bytes: &[u8]) -> io::Result<()> {
        let files = self
            .0
            .lock()
            .map_err(|_| io::Error::other("Log writer is unavailable."))?;
        while !bytes.is_empty() {
            let length = match fs::metadata(&files.path) {
                Ok(metadata) => metadata.len(),
                Err(error) if error.kind() == io::ErrorKind::NotFound => 0,
                Err(error) => return Err(error),
            };
            if length >= files.bytes {
                files.rotate()?;
                continue;
            }
            let count = bytes.len().min((files.bytes - length) as usize);
            // Do not retain a file handle across rotation, including on Windows.
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&files.path)?
                .write_all(&bytes[..count])?;
            bytes = &bytes[count..];
        }
        Ok(())
    }
}

impl LogFiles {
    fn at(&self, index: usize) -> PathBuf {
        if index == 0 {
            return self.path.clone();
        }
        let mut name = self.path.as_os_str().to_owned();
        name.push(format!(".{index}"));
        PathBuf::from(name)
    }

    fn rotate(&self) -> io::Result<()> {
        remove_if_present(&self.at(self.archives))?;
        for index in (1..=self.archives).rev() {
            match fs::rename(self.at(index - 1), self.at(index)) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn trim_tail(path: &Path, limit: u64) -> io::Result<()> {
    let mut file = match OpenOptions::new().read(true).write(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let length = file.metadata()?.len();
    if length <= limit {
        return Ok(());
    }
    let mut copied = 0;
    let mut buffer = [0; READ_BYTES];
    while copied < limit {
        let count = ((limit - copied) as usize).min(buffer.len());
        file.seek(SeekFrom::Start(length - limit + copied))?;
        file.read_exact(&mut buffer[..count])?;
        file.seek(SeekFrom::Start(copied))?;
        file.write_all(&buffer[..count])?;
        copied += count as u64;
    }
    file.set_len(limit)
}

pub struct LogDrains(Vec<JoinHandle<io::Result<()>>>);

impl LogDrains {
    pub fn attach(child: &mut Child, log: BoundedLog) -> io::Result<Self> {
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("Server stdout pipe is unavailable."))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| io::Error::other("Server stderr pipe is unavailable."))?;
        let output_log = log.clone();
        let output = thread::Builder::new()
            .name("server-stdout-log".into())
            .spawn(move || drain(stdout, output_log))?;
        let errors = thread::Builder::new()
            .name("server-stderr-log".into())
            .spawn(move || drain(stderr, log))?;
        Ok(Self(vec![output, errors]))
    }

    /// A descendant may retain a pipe after Node exits. Never wait indefinitely
    /// for that EOF: unfinished readers are reclaimed when the native host exits.
    pub fn finish(mut self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            let mut index = 0;
            while index < self.0.len() {
                if self.0[index].is_finished() {
                    let _ = self.0.swap_remove(index).join();
                } else {
                    index += 1;
                }
            }
            if self.0.is_empty() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(5));
        }
    }
}

fn drain(mut source: impl Read, log: BoundedLog) -> io::Result<()> {
    let mut buffer = [0; READ_BYTES];
    let mut write_error = None;
    loop {
        let count = match source.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        if let Err(error) = log.append(&buffer[..count]) {
            // Keep draining even if the disk is unavailable so a full pipe
            // cannot block the backend or its shutdown protocol.
            write_error.get_or_insert(error);
        }
    }
    write_error.map_or(Ok(()), Err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "pulse-log-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn log(&self, capacity: u64) -> BoundedLog {
            BoundedLog::open(self.0.join("fixture.log"), capacity, 2).unwrap()
        }
        fn retained(&self, capacity: u64) -> Vec<u8> {
            let files = LogFiles {
                path: self.0.join("fixture.log"),
                bytes: capacity,
                archives: 2,
            };
            let mut retained = Vec::new();
            for index in (0..=2).rev() {
                if let Ok(bytes) = fs::read(files.at(index)) {
                    assert!(bytes.len() as u64 <= capacity);
                    retained.extend(bytes);
                }
            }
            assert!(retained.len() as u64 <= capacity * 3);
            assert!(fs::read_dir(&self.0).unwrap().count() <= 3);
            retained
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn appends_and_partial_chunks_rotate_with_a_fixed_total_byte_cap() {
        let fixture = Fixture::new();
        let log = fixture.log(10);
        let mut written = Vec::new();
        for bytes in [
            b"abc".as_slice(),
            b"defghijklmnopq",
            b"rstuvwxyz0123456789",
            b"last",
        ] {
            log.append(bytes).unwrap();
            written.extend(bytes);
            let retained = fixture.retained(10);
            assert!(written.ends_with(&retained));
        }
        assert!(fixture.retained(10).ends_with(b"last"));
    }

    #[test]
    fn startup_bounds_preexisting_active_and_archive_tails() {
        let fixture = Fixture::new();
        let files = LogFiles {
            path: fixture.0.join("fixture.log"),
            bytes: 1024,
            archives: 2,
        };
        for index in 0..=2 {
            let mut bytes = vec![index as u8; 25_000];
            bytes.extend(b"retained-end");
            fs::write(files.at(index), bytes).unwrap();
        }
        let log = fixture.log(1024);
        for index in 0..=2 {
            let bytes = fs::read(files.at(index)).unwrap();
            assert_eq!(bytes.len(), 1024);
            assert!(bytes.ends_with(b"retained-end"));
        }
        log.append(b"new-end").unwrap();
        assert!(fixture.retained(1024).ends_with(b"new-end"));
    }

    #[test]
    fn emit_burst_fixture() {
        if std::env::var_os("PULSE_METRIC_STUDIO_TEST_LOG_BURST").is_none() {
            return;
        }
        for _ in 0..16 {
            std::io::stdout()
                .write_all(&[b'o'; READ_BYTES + 17])
                .unwrap();
            std::io::stderr()
                .write_all(&[b'e'; READ_BYTES + 31])
                .unwrap();
        }
        std::io::stdout().write_all(b"fixture-end").unwrap();
        std::io::stderr().write_all(b"fixture-end").unwrap();
    }

    #[test]
    fn real_child_stdout_and_stderr_bursts_are_drained_and_bounded() {
        let fixture = Fixture::new();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["emit_burst_fixture", "--nocapture"])
            .env("PULSE_METRIC_STUDIO_TEST_LOG_BURST", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let drains = LogDrains::attach(&mut child, fixture.log(4096)).unwrap();
        assert!(child.wait().unwrap().success());
        assert!(drains.finish(Duration::from_secs(5)));
        let retained = fixture.retained(4096);
        assert!(retained
            .windows(b"fixture-end".len())
            .any(|bytes| bytes == b"fixture-end"));
        assert!(retained.contains(&b'o') || retained.contains(&b'e'));
    }

    #[test]
    fn a_failed_log_sink_does_not_stop_pipe_consumption() {
        let fixture = Fixture::new();
        let log = fixture.log(1024);
        fs::create_dir(fixture.0.join("fixture.log")).unwrap();
        let mut source = io::Cursor::new(vec![b'x'; READ_BYTES * 5 + 13]);
        assert!(drain(&mut source, log).is_err());
        assert_eq!(source.position(), source.get_ref().len() as u64);
    }

    #[test]
    fn unfinished_readers_do_not_delay_shutdown() {
        let (release, blocked) = std::sync::mpsc::channel::<()>();
        let reader = thread::spawn(move || {
            blocked.recv().unwrap();
            Ok(())
        });
        assert!(!LogDrains(vec![reader]).finish(Duration::ZERO));
        release.send(()).unwrap();
    }
}
