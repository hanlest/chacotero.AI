# Configurar Git con SSH (puerto 443) en otro equipo

Guía para poder hacer `git push` a GitHub usando SSH cuando la red (por ejemplo corporativa) bloquea HTTPS o el puerto 22.

---

## 1. Tener Git instalado

- Windows: descarga desde https://git-scm.com/download/win  
- Verifica: `git --version`

---

## 2. Crear la carpeta y el archivo de configuración SSH

**Windows (PowerShell o CMD):**

```bash
mkdir %USERPROFILE%\.ssh 2>nul
notepad %USERPROFILE%\.ssh\config
```

**Mac / Linux:**

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
nano ~/.ssh/config
```

En el archivo **config** escribe (o agrega al final):

```
Host github.com
  Hostname ssh.github.com
  Port 443
  User git
```

Guarda y cierra. En Linux/Mac opcional: `chmod 600 ~/.ssh/config`

---

## 3. Generar una clave SSH

En terminal (Git Bash en Windows, o Terminal en Mac/Linux):

```bash
ssh-keygen -t ed25519 -C "tu-email@ejemplo.com" -f "%USERPROFILE%\.ssh\id_ed25519" -N ""
```

- En Mac/Linux usa: `-f "$HOME/.ssh/id_ed25519"`
- `-N ""` deja la clave sin passphrase (más cómodo; si quieres passphrase, quita `-N ""` y te lo pedirá).

---

## 4. Copiar la clave pública

**Windows:**

```bash
type %USERPROFILE%\.ssh\id_ed25519.pub
```

**Mac / Linux:**

```bash
cat ~/.ssh/id_ed25519.pub
```

Copia **toda la línea** que aparece (empieza con `ssh-ed25519` y termina con tu email).

---

## 5. Añadir la clave en GitHub

1. Entra en: **https://github.com/settings/keys**
2. Clic en **"New SSH key"**.
3. **Title:** un nombre para este equipo (ej. "PC oficina", "Laptop personal").
4. **Key:** pega la línea que copiaste en el paso 4.
5. Clic en **"Add SSH key"**.

---

## 6. Aceptar el host la primera vez (opcional)

La primera vez que te conectes, SSH preguntará si confías en el host. Escribe:

```
yes
```

y Enter. El fingerprint de GitHub es:  
`SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU`  
(puedes comprobarlo en https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints)

---

## 7. Usar SSH en tu repositorio

Si el repo sigue usando HTTPS, cámbialo a SSH:

```bash
cd ruta/al/repositorio
git remote set-url origin git@github.com:USUARIO/NOMBRE-REPO.git
```

Reemplaza `USUARIO` y `NOMBRE-REPO` por tu usuario de GitHub y el nombre del repo (ej. `hanlest/chacotero.AI`).

Verificar:

```bash
git remote -v
```

Debe aparecer algo como:

```
origin  git@github.com:USUARIO/NOMBRE-REPO.git (fetch)
origin  git@github.com:USUARIO/NOMBRE-REPO.git (push)
```

---

## 8. Probar

```bash
git push
```

Si todo está bien, el push se hará por SSH (puerto 443) sin pedir contraseña.

---

## Resumen rápido

| Paso | Qué hacer |
|------|-----------|
| 1 | Tener Git instalado |
| 2 | Crear `~/.ssh/config` con `Host github.com`, `Hostname ssh.github.com`, `Port 443`, `User git` |
| 3 | `ssh-keygen -t ed25519 -C "email" -f ~/.ssh/id_ed25519 -N ""` |
| 4 | Copiar contenido de `~/.ssh/id_ed25519.pub` |
| 5 | En GitHub → Settings → SSH and GPG keys → New SSH key → pegar clave |
| 6 | Primera conexión: escribir `yes` al preguntar por el host |
| 7 | `git remote set-url origin git@github.com:USUARIO/REPO.git` |
| 8 | `git push` |

---

## Si algo falla

- **"Permission denied (publickey)"**  
  La clave pública no está en GitHub o no es la que usa SSH. Revisa el paso 5 y que el archivo sea `id_ed25519` (sin otra extensión).

- **"Could not resolve hostname"**  
  Revisa que en `~/.ssh/config` esté `Hostname ssh.github.com` y `Port 443`.

- **Conexión lenta o timeout**  
  Algunas redes bloquean también el puerto 443 a ciertos destinos; en ese caso prueba desde otra red (por ejemplo datos del celular).
