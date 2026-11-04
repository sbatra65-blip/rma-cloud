using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace RMASystem.Migrations
{
    /// <inheritdoc />
    public partial class AddOemEmailSentFields : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "OemEmailSentAt",
                table: "RMATickets",
                type: "datetime",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "OemEmailSentBy",
                table: "RMATickets",
                type: "nvarchar(100)",
                maxLength: 100,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "OemEmailSentAt",
                table: "RMATickets");

            migrationBuilder.DropColumn(
                name: "OemEmailSentBy",
                table: "RMATickets");
        }
    }
}
