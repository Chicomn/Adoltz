function login(event) {
  event.preventDefault();
  const usuario = document.getElementById('usuario').value;
  const senha = document.getElementById('senha').value;

  if (usuario === 'admin' && senha === '1234') {
    window.location.href = 'home.html';
  } else {
    alert('Usuário ou senha incorretos');
  }
}
