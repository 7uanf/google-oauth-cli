# Política de privacidad — pf-hub (OAuth de Google)

**Última actualización:** 27 de noviembre de 2026.

`pf-hub` es una herramienta interna de automatización de Juan Fernández. Usa
**Google OAuth** únicamente para acceder, con el permiso explícito del titular, a
servicios de Google (por ejemplo, Gmail en solo lectura o la gestión de videos del
canal de YouTube del titular).

## Qué datos se acceden

- **Gmail:** solo lectura, con el alcance `gmail.readonly`.
- **YouTube:** gestión de videos propios, con el alcance `youtube.force-ssl`.

## Qué se hace con esos datos

- Se usan **solo** para la automatización interna del titular (leer correo y
  programar/publicar sus propios videos).
- **No se venden, no se comparten** con terceros y no se usan para publicidad.
- Los tokens de acceso viven en el entorno del titular (`.env` local) y **nunca** en
  repositorios públicos.

## Retención y revocación

- Los tokens pueden revocarse en cualquier momento desde
  [myaccount.google.com/connections](https://myaccount.google.com/connections).

## Contacto

- Correo: `wjjfernandez@gmail.com`
